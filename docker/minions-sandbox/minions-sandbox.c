/*
 * minions-sandbox: the L1 isolation wrapper for process-harness workers
 * (docs/design/agent-runtimes.md, D4 "L1, the isolation wrapper", D7).
 *
 *   minions-sandbox --rules <rules.json> [--] <command> [args...]
 *       Supervise <command> in its own process group (subreaper, parent-death signal) and run it under
 *       Landlock (filesystem allowlist, TCP-connect allowlist, signal and abstract-socket scoping) and a
 *       seccomp filter (native architecture only, socket families, no io_uring), with every descriptor
 *       above 2 closed. Exits with the command's status (128 + signal when it was killed).
 *   minions-sandbox --self-test <rules.json>
 *       Play the runner: open fixtures (unix sockets, a loopback TCP listener, a leaked descriptor), run
 *       the canaries below under the rules through the normal wrapper path, and report one line per check.
 *       Exit 0 = every restriction held, 1 = a canary escaped or could not be checked, 2 = Landlock ABI too
 *       low, 125 = usage or setup error.
 *   minions-sandbox --abi        Print the kernel's Landlock ABI version (0 = unavailable).
 *   minions-sandbox --version    Print the helper and rules-contract versions.
 *
 * Exit status 125 always means the sandbox itself failed (bad rules, kernel refused a restriction); the
 * command was not started. 126/127: the command could not be executed / was not found.
 *
 * The rules file is JSON written by the runner (src/runtime/sandbox/rules.ts is the contract):
 *   { "version": 1, "minAbi": 6, "label": "...",
 *     "fs": [ { "path": "/usr", "access": ["read", "execute"], "optional": true }, ... ],
 *     "tcpConnectPorts": [443],
 *     "selfTest": { "fixtureDir": "...", "allowWrite": "...", "allowRead": [...],
 *                   "denyRead": [...], "denyWrite": [...] } }
 * Unknown keys are refused, so a runner/helper version mismatch fails closed.
 *
 * Self-test output (tab-separated, parsed by src/runtime/sandbox/selftest.ts):
 *   minions-sandbox-selftest <protocol>
 *   version <helper version>
 *   arch <x86_64|aarch64>
 *   abi <n>
 *   check <name> <pass|escaped|error|skip> <detail>     (repeated)
 *   result <ok|fail|unavailable|error> <detail>
 *
 * Supported architectures: x86_64 and aarch64 (the image is built natively for both).
 */
#define _GNU_SOURCE
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/ioctl.h>
#include <sched.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <sys/xattr.h>

#define HELPER_VERSION "1.0.0"
#define RULES_VERSION 1
#define SELFTEST_PROTOCOL 1
#define MIN_ABI 6
#define GRACE_SECONDS 15      /* SIGTERM -> SIGKILL (D4 "Process lifetime") */
#define LIFETIME_SECONDS 20   /* the canary tree must be gone this long after the runner is SIGKILLed */
#define EXIT_SANDBOX 125

#if defined(__x86_64__)
# define NATIVE_ARCH AUDIT_ARCH_X86_64
# define ARCH_NAME "x86_64"
#elif defined(__aarch64__)
# define NATIVE_ARCH AUDIT_ARCH_AARCH64
# define ARCH_NAME "aarch64"
#else
# error "minions-sandbox supports x86_64 and aarch64 only"
#endif

/* ------------------------------------------------------------------ kernel UAPI (defined here so the
 * build does not depend on the toolchain's linux-libc-dev version; values are stable kernel ABI) */

#ifndef __NR_landlock_create_ruleset
# define __NR_landlock_create_ruleset 444
#endif
#ifndef __NR_landlock_add_rule
# define __NR_landlock_add_rule 445
#endif
#ifndef __NR_landlock_restrict_self
# define __NR_landlock_restrict_self 446
#endif
#ifndef __NR_close_range
# define __NR_close_range 436
#endif
#ifndef __NR_io_uring_setup
# define __NR_io_uring_setup 425
#endif
#ifndef __NR_io_uring_enter
# define __NR_io_uring_enter 426
#endif
#ifndef __NR_io_uring_register
# define __NR_io_uring_register 427
#endif
#ifndef SECCOMP_RET_KILL_PROCESS
# define SECCOMP_RET_KILL_PROCESS 0x80000000U
#endif
#ifndef SECCOMP_RET_USER_NOTIF
# define SECCOMP_RET_USER_NOTIF 0x7fc00000U
#endif
#ifndef SECCOMP_SET_MODE_FILTER
# define SECCOMP_SET_MODE_FILTER 1
#endif
#ifndef SECCOMP_FILTER_FLAG_NEW_LISTENER
# define SECCOMP_FILTER_FLAG_NEW_LISTENER (1UL << 3)
#endif
#define X32_SYSCALL_BIT 0x40000000U

#define LL_CREATE_RULESET_VERSION (1U << 0)
#define LL_RULE_PATH_BENEATH 1
#define LL_RULE_NET_PORT 2

#define LL_FS_EXECUTE     (1ULL << 0)
#define LL_FS_WRITE_FILE  (1ULL << 1)
#define LL_FS_READ_FILE   (1ULL << 2)
#define LL_FS_READ_DIR    (1ULL << 3)
#define LL_FS_REMOVE_DIR  (1ULL << 4)
#define LL_FS_REMOVE_FILE (1ULL << 5)
#define LL_FS_MAKE_CHAR   (1ULL << 6)
#define LL_FS_MAKE_DIR    (1ULL << 7)
#define LL_FS_MAKE_REG    (1ULL << 8)
#define LL_FS_MAKE_SOCK   (1ULL << 9)
#define LL_FS_MAKE_FIFO   (1ULL << 10)
#define LL_FS_MAKE_BLOCK  (1ULL << 11)
#define LL_FS_MAKE_SYM    (1ULL << 12)
#define LL_FS_REFER       (1ULL << 13) /* ABI 2 */
#define LL_FS_TRUNCATE    (1ULL << 14) /* ABI 3 */
#define LL_FS_IOCTL_DEV   (1ULL << 15) /* ABI 5 */
#define LL_NET_CONNECT_TCP (1ULL << 1)  /* ABI 4 */
#define LL_SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0) /* ABI 6 */
#define LL_SCOPE_SIGNAL (1ULL << 1)               /* ABI 6 */

#define LL_FS_FILE_RIGHTS (LL_FS_EXECUTE | LL_FS_WRITE_FILE | LL_FS_READ_FILE | LL_FS_TRUNCATE | LL_FS_IOCTL_DEV)

struct ll_ruleset_attr { uint64_t handled_access_fs; uint64_t handled_access_net; uint64_t scoped; };
struct ll_path_beneath_attr { uint64_t allowed_access; int32_t parent_fd; } __attribute__((packed));
struct ll_net_port_attr { uint64_t allowed_access; uint64_t port; };

/* ------------------------------------------------------------------ small helpers */

static const char *label = "";

static void say(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  fprintf(stderr, "minions-sandbox%s%s: ", *label ? " " : "", label);
  vfprintf(stderr, fmt, ap);
  fputc('\n', stderr);
  va_end(ap);
}

static void die(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  fprintf(stderr, "minions-sandbox%s%s: ", *label ? " " : "", label);
  vfprintf(stderr, fmt, ap);
  fputc('\n', stderr);
  va_end(ap);
  _exit(EXIT_SANDBOX);
}

static void *xmalloc(size_t n) {
  void *p = malloc(n ? n : 1);
  if (!p) die("out of memory");
  return p;
}

static void *xrealloc(void *p, size_t n) {
  p = realloc(p, n ? n : 1);
  if (!p) die("out of memory");
  return p;
}

static long long now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static int landlock_abi(void) {
  long v = syscall(__NR_landlock_create_ruleset, NULL, 0, LL_CREATE_RULESET_VERSION);
  return v < 0 ? 0 : (int)v;
}

/* ------------------------------------------------------------------ minimal JSON (objects, arrays,
 * strings, integers, booleans, null). The process is short-lived, so parsed values are never freed. */

enum jtype { J_NULL, J_BOOL, J_INT, J_STR, J_ARR, J_OBJ };
struct jv {
  enum jtype t;
  long long n;          /* J_INT, J_BOOL */
  char *s;              /* J_STR */
  struct jv *items;     /* J_ARR, J_OBJ values */
  char **keys;          /* J_OBJ keys */
  size_t len;
};
struct jp { const char *p, *end; int depth; const char *err; };

static int jfail(struct jp *j, const char *m) { if (!j->err) j->err = m; return -1; }
static void jws(struct jp *j) { while (j->p < j->end && (*j->p == ' ' || *j->p == '\t' || *j->p == '\n' || *j->p == '\r')) j->p++; }

static void jput(char **b, size_t *n, size_t *cap, unsigned char c) {
  if (*n + 2 > *cap) { *cap *= 2; *b = xrealloc(*b, *cap); }
  (*b)[(*n)++] = (char)c;
}

static int jhex4(struct jp *j, uint32_t *out) {
  uint32_t v = 0;
  for (int i = 0; i < 4; i++) {
    if (j->p >= j->end) return jfail(j, "truncated \\u escape");
    char c = *j->p++;
    v <<= 4;
    if (c >= '0' && c <= '9') v |= (uint32_t)(c - '0');
    else if (c >= 'a' && c <= 'f') v |= (uint32_t)(c - 'a' + 10);
    else if (c >= 'A' && c <= 'F') v |= (uint32_t)(c - 'A' + 10);
    else return jfail(j, "bad \\u escape");
  }
  *out = v;
  return 0;
}

static int jstr(struct jp *j, char **out) {
  size_t cap = 32, n = 0;
  char *b = xmalloc(cap);
  j->p++; /* opening quote */
  while (j->p < j->end && *j->p != '"') {
    unsigned char c = (unsigned char)*j->p++;
    if (c < 0x20) return jfail(j, "control character in string");
    if (c != '\\') { jput(&b, &n, &cap, c); continue; }
    if (j->p >= j->end) return jfail(j, "truncated escape");
    c = (unsigned char)*j->p++;
    uint32_t cp;
    switch (c) {
      case '"': case '\\': case '/': jput(&b, &n, &cap, c); continue;
      case 'b': jput(&b, &n, &cap, '\b'); continue;
      case 'f': jput(&b, &n, &cap, '\f'); continue;
      case 'n': jput(&b, &n, &cap, '\n'); continue;
      case 'r': jput(&b, &n, &cap, '\r'); continue;
      case 't': jput(&b, &n, &cap, '\t'); continue;
      case 'u':
        if (jhex4(j, &cp) < 0) return -1;
        if (cp >= 0xD800 && cp <= 0xDBFF) {
          uint32_t lo;
          if (j->end - j->p < 2 || j->p[0] != '\\' || j->p[1] != 'u') return jfail(j, "lone surrogate");
          j->p += 2;
          if (jhex4(j, &lo) < 0) return -1;
          if (lo < 0xDC00 || lo > 0xDFFF) return jfail(j, "bad surrogate pair");
          cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
        } else if (cp >= 0xDC00 && cp <= 0xDFFF) return jfail(j, "lone surrogate");
        if (cp == 0) return jfail(j, "NUL in string");
        if (cp < 0x80) jput(&b, &n, &cap, (unsigned char)cp);
        else if (cp < 0x800) { jput(&b, &n, &cap, 0xC0 | (cp >> 6)); jput(&b, &n, &cap, 0x80 | (cp & 0x3F)); }
        else if (cp < 0x10000) { jput(&b, &n, &cap, 0xE0 | (cp >> 12)); jput(&b, &n, &cap, 0x80 | ((cp >> 6) & 0x3F)); jput(&b, &n, &cap, 0x80 | (cp & 0x3F)); }
        else { jput(&b, &n, &cap, 0xF0 | (cp >> 18)); jput(&b, &n, &cap, 0x80 | ((cp >> 12) & 0x3F)); jput(&b, &n, &cap, 0x80 | ((cp >> 6) & 0x3F)); jput(&b, &n, &cap, 0x80 | (cp & 0x3F)); }
        continue;
      default: return jfail(j, "bad escape");
    }
  }
  if (j->p >= j->end) return jfail(j, "unterminated string");
  j->p++; /* closing quote */
  b[n] = '\0';
  *out = b;
  return 0;
}

static int jvalue(struct jp *j, struct jv *v);

static int jlit(struct jp *j, const char *lit) {
  size_t n = strlen(lit);
  if ((size_t)(j->end - j->p) < n || memcmp(j->p, lit, n) != 0) return jfail(j, "unexpected token");
  j->p += n;
  return 0;
}

static int jvalue(struct jp *j, struct jv *v) {
  memset(v, 0, sizeof *v);
  jws(j);
  if (j->p >= j->end) return jfail(j, "unexpected end of input");
  if (++j->depth > 16) return jfail(j, "nesting too deep");
  int rc = 0;
  char c = *j->p;
  if (c == '{' || c == '[') {
    char close = c == '{' ? '}' : ']';
    size_t cap = 4;
    v->t = c == '{' ? J_OBJ : J_ARR;
    v->items = xmalloc(cap * sizeof *v->items);
    if (v->t == J_OBJ) v->keys = xmalloc(cap * sizeof *v->keys);
    j->p++;
    jws(j);
    if (j->p < j->end && *j->p == close) { j->p++; j->depth--; return 0; }
    for (;;) {
      if (v->len == cap) {
        cap *= 2;
        v->items = xrealloc(v->items, cap * sizeof *v->items);
        if (v->t == J_OBJ) v->keys = xrealloc(v->keys, cap * sizeof *v->keys);
      }
      if (v->t == J_OBJ) {
        jws(j);
        if (j->p >= j->end || *j->p != '"') return jfail(j, "expected a key");
        if (jstr(j, &v->keys[v->len]) < 0) return -1;
        for (size_t i = 0; i < v->len; i++) if (strcmp(v->keys[i], v->keys[v->len]) == 0) return jfail(j, "duplicate key");
        jws(j);
        if (j->p >= j->end || *j->p != ':') return jfail(j, "expected ':'");
        j->p++;
      }
      if (jvalue(j, &v->items[v->len]) < 0) return -1;
      v->len++;
      jws(j);
      if (j->p < j->end && *j->p == ',') { j->p++; continue; }
      if (j->p < j->end && *j->p == close) { j->p++; break; }
      return jfail(j, "expected ',' or a closing bracket");
    }
  } else if (c == '"') {
    v->t = J_STR;
    rc = jstr(j, &v->s);
  } else if (c == '-' || (c >= '0' && c <= '9')) {
    int neg = c == '-';
    long long n = 0;
    if (neg) j->p++;
    if (j->p >= j->end || !isdigit((unsigned char)*j->p)) return jfail(j, "bad number");
    while (j->p < j->end && isdigit((unsigned char)*j->p)) {
      if (n > 1000000000000LL) return jfail(j, "number too large");
      n = n * 10 + (*j->p++ - '0');
    }
    if (j->p < j->end && (*j->p == '.' || *j->p == 'e' || *j->p == 'E')) return jfail(j, "only integers are accepted");
    v->t = J_INT;
    v->n = neg ? -n : n;
  } else if (c == 't') { v->t = J_BOOL; v->n = 1; rc = jlit(j, "true"); }
  else if (c == 'f') { v->t = J_BOOL; v->n = 0; rc = jlit(j, "false"); }
  else if (c == 'n') { v->t = J_NULL; rc = jlit(j, "null"); }
  else rc = jfail(j, "unexpected character");
  j->depth--;
  return rc;
}

static struct jv *jget(const struct jv *o, const char *key) {
  for (size_t i = 0; i < o->len; i++) if (strcmp(o->keys[i], key) == 0) return &o->items[i];
  return NULL;
}

/* ------------------------------------------------------------------ rules */

#define A_READ 1u
#define A_WRITE 2u
#define A_EXEC 4u

struct fsrule { const char *path; unsigned access; int optional; };
struct strlist { const char **v; size_t n; };
struct rules {
  int min_abi;
  struct fsrule *fs; size_t nfs;
  unsigned *ports; size_t nports;
  int has_selftest;
  const char *fixture_dir, *allow_write;
  struct strlist allow_read, deny_read, deny_write;
};

static void only_keys(const struct jv *o, const char *where, const char *const *allowed) {
  for (size_t i = 0; i < o->len; i++) {
    int ok = 0;
    for (const char *const *a = allowed; *a; a++) if (strcmp(*a, o->keys[i]) == 0) ok = 1;
    if (!ok) die("rules: unknown key \"%s\" in %s", o->keys[i], where);
  }
}

/* Absolute, no "." or ".." segment, no empty segment, no tab or newline (they would break the
 * line-based self-test protocol), shorter than PATH_MAX. */
static const char *checked_path(const struct jv *v, const char *where) {
  if (!v || v->t != J_STR) die("rules: %s must be a string", where);
  const char *p = v->s;
  size_t n = strlen(p);
  if (n == 0 || p[0] != '/' || n >= PATH_MAX) die("rules: %s must be an absolute path", where);
  if (strpbrk(p, "\t\n\r")) die("rules: %s contains a control character", where);
  if (strcmp(p, "/") == 0) die("rules: %s must not be the root directory", where);
  for (const char *s = p; *s; ) {
    const char *e = strchr(s + 1, '/');
    size_t seg = e ? (size_t)(e - s - 1) : strlen(s + 1);
    if (seg == 0 && (e || s != p)) die("rules: %s has an empty path segment", where);
    if ((seg == 1 && s[1] == '.') || (seg == 2 && s[1] == '.' && s[2] == '.')) die("rules: %s has a . or .. segment", where);
    if (!e) break;
    s = e;
  }
  return p;
}

static void path_list(const struct jv *v, const char *where, struct strlist *out) {
  if (!v) { out->v = NULL; out->n = 0; return; }
  if (v->t != J_ARR) die("rules: %s must be an array", where);
  out->v = xmalloc(v->len * sizeof *out->v);
  out->n = v->len;
  for (size_t i = 0; i < v->len; i++) out->v[i] = checked_path(&v->items[i], where);
}

static void load_rules(const char *file, struct rules *r) {
  int fd = open(file, O_RDONLY | O_CLOEXEC);
  if (fd < 0) die("cannot open rules %s: %s", file, strerror(errno));
  size_t cap = 4096, n = 0;
  char *buf = xmalloc(cap);
  for (;;) {
    if (n == cap) { if (cap >= (1u << 20)) die("rules file too large"); cap *= 2; buf = xrealloc(buf, cap); }
    ssize_t k = read(fd, buf + n, cap - n);
    if (k < 0) { if (errno == EINTR) continue; die("cannot read rules: %s", strerror(errno)); }
    if (k == 0) break;
    n += (size_t)k;
  }
  close(fd);

  struct jp j = { buf, buf + n, 0, NULL };
  struct jv root;
  if (jvalue(&j, &root) < 0) die("rules: invalid JSON: %s", j.err);
  jws(&j);
  if (j.p != j.end) die("rules: trailing data after the JSON object");
  if (root.t != J_OBJ) die("rules: top level must be an object");
  static const char *const top[] = { "version", "minAbi", "label", "fs", "tcpConnectPorts", "selfTest", NULL };
  only_keys(&root, "rules", top);

  struct jv *v = jget(&root, "version");
  if (!v || v->t != J_INT || v->n != RULES_VERSION) die("rules: version must be %d", RULES_VERSION);
  v = jget(&root, "minAbi");
  if (!v || v->t != J_INT || v->n < MIN_ABI || v->n > 1000) die("rules: minAbi must be an integer >= %d", MIN_ABI);
  r->min_abi = (int)v->n;
  v = jget(&root, "label");
  if (v) {
    if (v->t != J_STR || strlen(v->s) > 200 || strpbrk(v->s, "\t\n\r")) die("rules: label must be a short single-line string");
    label = v->s;
  }

  v = jget(&root, "fs");
  if (!v || v->t != J_ARR || v->len == 0) die("rules: fs must be a non-empty array");
  r->fs = xmalloc(v->len * sizeof *r->fs);
  r->nfs = v->len;
  for (size_t i = 0; i < v->len; i++) {
    const struct jv *e = &v->items[i];
    static const char *const keys[] = { "path", "access", "optional", NULL };
    if (e->t != J_OBJ) die("rules: fs entries must be objects");
    only_keys(e, "an fs entry", keys);
    r->fs[i].path = checked_path(jget(e, "path"), "fs[].path");
    const struct jv *a = jget(e, "access");
    if (!a || a->t != J_ARR || a->len == 0) die("rules: fs[].access must be a non-empty array");
    r->fs[i].access = 0;
    for (size_t k = 0; k < a->len; k++) {
      if (a->items[k].t != J_STR) die("rules: fs[].access entries must be strings");
      const char *s = a->items[k].s;
      if (strcmp(s, "read") == 0) r->fs[i].access |= A_READ;
      else if (strcmp(s, "write") == 0) r->fs[i].access |= A_WRITE;
      else if (strcmp(s, "execute") == 0) r->fs[i].access |= A_EXEC;
      else die("rules: unknown access \"%s\"", s);
    }
    const struct jv *o = jget(e, "optional");
    if (o && o->t != J_BOOL) die("rules: fs[].optional must be a boolean");
    r->fs[i].optional = o ? (int)o->n : 0;
  }

  v = jget(&root, "tcpConnectPorts");
  if (!v || v->t != J_ARR || v->len == 0) die("rules: tcpConnectPorts must be a non-empty array");
  r->ports = xmalloc(v->len * sizeof *r->ports);
  r->nports = v->len;
  for (size_t i = 0; i < v->len; i++) {
    if (v->items[i].t != J_INT || v->items[i].n < 1 || v->items[i].n > 65535) die("rules: tcpConnectPorts holds ports 1 to 65535");
    r->ports[i] = (unsigned)v->items[i].n;
  }

  v = jget(&root, "selfTest");
  r->has_selftest = v != NULL;
  if (v) {
    static const char *const keys[] = { "fixtureDir", "allowWrite", "allowRead", "denyRead", "denyWrite", NULL };
    if (v->t != J_OBJ) die("rules: selfTest must be an object");
    only_keys(v, "selfTest", keys);
    r->fixture_dir = checked_path(jget(v, "fixtureDir"), "selfTest.fixtureDir");
    r->allow_write = checked_path(jget(v, "allowWrite"), "selfTest.allowWrite");
    path_list(jget(v, "allowRead"), "selfTest.allowRead", &r->allow_read);
    path_list(jget(v, "denyRead"), "selfTest.denyRead", &r->deny_read);
    path_list(jget(v, "denyWrite"), "selfTest.denyWrite", &r->deny_write);
    if (r->deny_read.n == 0 || r->deny_write.n == 0) die("rules: selfTest needs denyRead and denyWrite paths");
  }
}

/* ------------------------------------------------------------------ confinement (runs in the child) */

static uint64_t fs_handled(int abi) {
  uint64_t a = LL_FS_EXECUTE | LL_FS_WRITE_FILE | LL_FS_READ_FILE | LL_FS_READ_DIR | LL_FS_REMOVE_DIR |
               LL_FS_REMOVE_FILE | LL_FS_MAKE_CHAR | LL_FS_MAKE_DIR | LL_FS_MAKE_REG | LL_FS_MAKE_SOCK |
               LL_FS_MAKE_FIFO | LL_FS_MAKE_BLOCK | LL_FS_MAKE_SYM;
  if (abi >= 2) a |= LL_FS_REFER;
  if (abi >= 3) a |= LL_FS_TRUNCATE;
  if (abi >= 5) a |= LL_FS_IOCTL_DEV;
  return a;
}

static uint64_t fs_rights(unsigned access, int is_dir, uint64_t handled) {
  uint64_t r = 0;
  if (access & A_READ) r |= LL_FS_READ_FILE | LL_FS_READ_DIR;
  if (access & A_EXEC) r |= LL_FS_EXECUTE;
  if (access & A_WRITE)
    r |= LL_FS_WRITE_FILE | LL_FS_TRUNCATE | LL_FS_IOCTL_DEV | LL_FS_REMOVE_DIR | LL_FS_REMOVE_FILE |
         LL_FS_MAKE_CHAR | LL_FS_MAKE_DIR | LL_FS_MAKE_REG | LL_FS_MAKE_SOCK | LL_FS_MAKE_FIFO |
         LL_FS_MAKE_BLOCK | LL_FS_MAKE_SYM | LL_FS_REFER;
  if (!is_dir) r &= LL_FS_FILE_RIGHTS; /* the kernel refuses directory rights on a file */
  return r & handled;
}

/* Each 64-bit syscall argument is two 32-bit words in struct seccomp_data; load the low or the high
 * word by endianness. ARG0_LOW is kept for the socket() family check below. */
#if __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
# define ARG_LO(i) (offsetof(struct seccomp_data, args[i]))
# define ARG_HI(i) (offsetof(struct seccomp_data, args[i]) + 4)
#else
# define ARG_LO(i) (offsetof(struct seccomp_data, args[i]) + 4)
# define ARG_HI(i) (offsetof(struct seccomp_data, args[i]))
#endif
#define ARG0_LOW ARG_LO(0)

/* These blocks leave the accumulator holding the syscall number on the "not this syscall" path, so the
 * next block can keep matching; on the "this syscall" path every branch returns, so A is never stale. */

/* Unconditional deny by number (2 insns). */
#define DENY_NR(nr, err) \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (nr), 0, 1), \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (err))

/* Hand <nr> to the supervisor over the user-notification fd, which allows it only when its target path is
 * inside the writable set and performs it TOCTOU-safely, else returns EPERM (2 insns). */
#define NOTIFY_NR(nr) \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (nr), 0, 1), \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF)

/* Deny <nr> when the given argument's low word has any bit of <mask> set, else allow (5 insns).
 * MSG_FASTOPEN lives in the low word, so only the low word is tested. */
#define DENY_FLAG(nr, argidx, mask, err) \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (nr), 0, 4), \
  BPF_STMT(BPF_LD | BPF_W | BPF_ABS, ARG_LO(argidx)), \
  BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, (mask), 0, 1), \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (err)), \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)

/* Allow <nr> only when argument <argidx> is 0 (self: pid/who 0), else deny (7 insns). Both 32-bit words
 * must be 0, so a negative value (a process group, or -1 for "every process") is also denied. */
#define DENY_UNLESS_SELF(nr, argidx, err) \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (nr), 0, 6), \
  BPF_STMT(BPF_LD | BPF_W | BPF_ABS, ARG_HI(argidx)), \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 0, 3), \
  BPF_STMT(BPF_LD | BPF_W | BPF_ABS, ARG_LO(argidx)), \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 0, 1), \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW), \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (err))

/* Like DENY_UNLESS_SELF for the calls whose arg0 says what arg1 names (setpriority/getpriority: PRIO_*,
 * ioprio_set: IOPRIO_WHO_*): allow only when arg0 is <self_which> or <pgrp_which> and arg1 is 0, i.e.
 * the caller itself or its own process group (the sandbox's, by setpgid). The "user" form with 0 means
 * "every process of the caller's uid" (coordinator and runner included), so it is denied, like any other
 * value; only the low word of arg0 is tested because the kernel takes it as an int (11 insns). */
#define DENY_UNLESS_SELF_WHICH(nr, self_which, pgrp_which, err) \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (nr), 0, 9), \
  BPF_STMT(BPF_LD | BPF_W | BPF_ABS, ARG_LO(0)), \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (self_which), 1, 0), \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (pgrp_which), 0, 5), \
  BPF_STMT(BPF_LD | BPF_W | BPF_ABS, ARG_HI(1)), \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 0, 3), \
  BPF_STMT(BPF_LD | BPF_W | BPF_ABS, ARG_LO(1)), \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 0, 1), \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW), \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (err))
#define IOPRIO_WHO_PROCESS_ 1
#define IOPRIO_WHO_PGRP_ 2

#ifndef __NR_fchmodat2
# define __NR_fchmodat2 452
#endif
/* The *xattrat family (Linux 6.13) and file_setattr (6.17) come from the unified syscall table, so the
 * numbers are the same on x86_64 and aarch64. Denying a number the kernel does not have is harmless. */
#ifndef __NR_setxattrat
# define __NR_setxattrat 463
#endif
#ifndef __NR_removexattrat
# define __NR_removexattrat 466
#endif
#ifndef __NR_file_setattr
# define __NR_file_setattr 469
#endif
#ifndef TIOCSTI
# define TIOCSTI 0x5412
#endif
#ifndef TIOCLINUX
# define TIOCLINUX 0x541C
#endif
#ifndef IPPROTO_MPTCP
# define IPPROTO_MPTCP 262
#endif
#ifndef MSG_FASTOPEN
# define MSG_FASTOPEN 0x20000000
#endif
#ifndef TCP_FASTOPEN_CONNECT
# define TCP_FASTOPEN_CONNECT 30
#endif

/* ------------------------------------------------------------------ user-notification handler for the
 * path-based chmod syscalls. It runs in the supervisor, outside the Landlock domain, and allows a chmod
 * only when its target resolves inside the writable set; it then performs the chmod on the pinned inode
 * (TOCTOU-safe), so a symlink swap after the check cannot redirect it. */

/* A file descriptor is carried over a connected AF_UNIX socket with SCM_RIGHTS: the child creates the
 * notification fd after close_range, so it cannot simply be inherited; it is sent to the supervisor. */
static int send_fd(int sock, int fd) {
  char cbuf[CMSG_SPACE(sizeof(int))];
  char data = 'F';
  struct iovec io = { &data, 1 };
  struct msghdr msg;
  memset(&msg, 0, sizeof msg);
  memset(cbuf, 0, sizeof cbuf);
  msg.msg_iov = &io;
  msg.msg_iovlen = 1;
  msg.msg_control = cbuf;
  msg.msg_controllen = sizeof cbuf;
  struct cmsghdr *cm = CMSG_FIRSTHDR(&msg);
  cm->cmsg_level = SOL_SOCKET;
  cm->cmsg_type = SCM_RIGHTS;
  cm->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(cm), &fd, sizeof(int));
  ssize_t n;
  do { n = sendmsg(sock, &msg, 0); } while (n < 0 && errno == EINTR);
  return n < 0 ? -1 : 0;
}

static int recv_fd(int sock) {
  char cbuf[CMSG_SPACE(sizeof(int))];
  char data = 0;
  struct iovec io = { &data, 1 };
  struct msghdr msg;
  memset(&msg, 0, sizeof msg);
  memset(cbuf, 0, sizeof cbuf);
  msg.msg_iov = &io;
  msg.msg_iovlen = 1;
  msg.msg_control = cbuf;
  msg.msg_controllen = sizeof cbuf;
  ssize_t n;
  do { n = recvmsg(sock, &msg, MSG_CMSG_CLOEXEC); } while (n < 0 && errno == EINTR);
  if (n <= 0) return -1;
  for (struct cmsghdr *cm = CMSG_FIRSTHDR(&msg); cm; cm = CMSG_NXTHDR(&msg, cm)) {
    if (cm->cmsg_level == SOL_SOCKET && cm->cmsg_type == SCM_RIGHTS && cm->cmsg_len == CMSG_LEN(sizeof(int))) {
      int fd;
      memcpy(&fd, CMSG_DATA(cm), sizeof(int));
      return fd;
    }
  }
  return -1;
}

/* Read a NUL-terminated path from another process's memory at <addr>. */
static int read_remote_path(pid_t pid, unsigned long long addr, char *buf, size_t len) {
  char mp[64];
  snprintf(mp, sizeof mp, "/proc/%d/mem", (int)pid);
  int fd = open(mp, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  size_t got = 0;
  while (got < len - 1) {
    ssize_t k = pread(fd, buf + got, len - 1 - got, (off_t)(addr + got));
    if (k < 0) { if (errno == EINTR) continue; close(fd); return -1; }
    if (k == 0) break;
    for (ssize_t i = 0; i < k; i++) if (buf[got + i] == '\0') { close(fd); return 0; }
    got += (size_t)k;
  }
  close(fd);
  return -1; /* no terminator within PATH_MAX: reject */
}

/* True when <canon> (an already-resolved absolute path) is one of, or beneath, the rules' writable dirs. */
static int path_within_writable(const struct rules *r, const char *canon) {
  size_t cl = strlen(canon);
  for (size_t i = 0; i < r->nfs; i++) {
    if (!(r->fs[i].access & A_WRITE) || strcmp(r->fs[i].path, "/dev/null") == 0) continue;
    char resolved[PATH_MAX];
    if (!realpath(r->fs[i].path, resolved)) continue;
    size_t wl = strlen(resolved);
    if (cl == wl && memcmp(canon, resolved, wl) == 0) return 1;
    if (cl > wl && memcmp(canon, resolved, wl) == 0 && canon[wl] == '/') return 1;
  }
  return 0;
}

/* Resolve the chmod target in the caller's filesystem view, verify it is writable, and chmod the pinned
 * inode. Returns 0 on success or a negated errno for the worker. */
static long chmod_in_writable(const struct rules *r, pid_t pid, int dirfd, unsigned long long pathaddr, mode_t mode) {
  char path[PATH_MAX];
  if (read_remote_path(pid, pathaddr, path, sizeof path) < 0) return -ENAMETOOLONG;
  char basepath[64];
  int base;
  if (path[0] == '/') { snprintf(basepath, sizeof basepath, "/proc/%d/root", (int)pid); base = open(basepath, O_PATH | O_CLOEXEC); }
  else if (dirfd == AT_FDCWD) { snprintf(basepath, sizeof basepath, "/proc/%d/cwd", (int)pid); base = open(basepath, O_PATH | O_DIRECTORY | O_CLOEXEC); }
  else { snprintf(basepath, sizeof basepath, "/proc/%d/fd/%d", (int)pid, dirfd); base = open(basepath, O_PATH | O_DIRECTORY | O_CLOEXEC); }
  if (base < 0) return -errno;
  const char *rel = path[0] == '/' ? path + 1 : path;
  if (!*rel) rel = ".";
  /* O_PATH without O_NOFOLLOW follows the final symlink as chmod would; the fd then pins that inode. */
  int tfd = openat(base, rel, O_PATH | O_CLOEXEC);
  int oerr = errno;
  close(base);
  if (tfd < 0) return -oerr;
  char link[64], canon[PATH_MAX];
  snprintf(link, sizeof link, "/proc/self/fd/%d", tfd);
  ssize_t cl = readlink(link, canon, sizeof canon - 1);
  if (cl < 0) { int e = errno; close(tfd); return -e; }
  canon[cl] = '\0';
  if (!path_within_writable(r, canon)) { close(tfd); return -EPERM; }
  /* chmod the inode by its magic /proc/self/fd link: swapping the original path cannot redirect it. */
  long rc = fchmodat(AT_FDCWD, link, mode & 07777, 0) < 0 ? -errno : 0;
  close(tfd);
  return rc;
}

/* Service one pending notification on the listener fd. */
static void handle_notif(int listener, const struct rules *r) {
  struct seccomp_notif req;
  memset(&req, 0, sizeof req);
  if (ioctl(listener, SECCOMP_IOCTL_NOTIF_RECV, &req) < 0) return; /* EINTR / target vanished */
  struct seccomp_notif_resp resp;
  memset(&resp, 0, sizeof resp);
  resp.id = req.id;
  int nr = req.data.nr;
  int dirfd = AT_FDCWD;
  unsigned long long pathaddr;
  mode_t mode;
  if (nr == __NR_fchmodat || nr == __NR_fchmodat2) { dirfd = (int)req.data.args[0]; pathaddr = req.data.args[1]; mode = (mode_t)req.data.args[2]; resp.error = (int)chmod_in_writable(r, (pid_t)req.pid, dirfd, pathaddr, mode); }
#ifdef __NR_chmod
  else if (nr == __NR_chmod) { pathaddr = req.data.args[0]; mode = (mode_t)req.data.args[1]; resp.error = (int)chmod_in_writable(r, (pid_t)req.pid, dirfd, pathaddr, mode); }
#endif
  else resp.error = -ENOSYS;
  /* Only answer if the request is still live, else the SEND would race a dead target. */
  if (ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, &req.id) == 0) ioctl(listener, SECCOMP_IOCTL_NOTIF_SEND, &resp);
}

static int install_seccomp(void) {
  struct sock_filter f[] = {
    /* Any non-native ABI ends the process: on x86_64 the i386 compat table (socketcall included). */
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, NATIVE_ARCH, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
    /* x32 syscalls carry AUDIT_ARCH_X86_64 with __X32_SYSCALL_BIT set in the number. */
    BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, X32_SYSCALL_BIT, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
    /* IORING_OP_SOCKET / IORING_OP_CONNECT would bypass the socket() check below. */
    DENY_NR(__NR_io_uring_setup, ENOSYS),
    DENY_NR(__NR_io_uring_enter, ENOSYS),
    DENY_NR(__NR_io_uring_register, ENOSYS),

    /* TCP Fast Open: sendto/sendmsg/sendmmsg with MSG_FASTOPEN connect a TCP socket without connect(),
     * past Landlock's TCP-connect allowlist. Deny that flag; plain sends are untouched. (flags is arg3
     * for sendto/sendmmsg, arg2 for sendmsg.) The i386 socketcall path is already killed by the arch
     * check, and x32 by the __X32_SYSCALL_BIT check, so filtering the native numbers is enough. */
    DENY_FLAG(__NR_sendto, 3, MSG_FASTOPEN, EOPNOTSUPP),
    DENY_FLAG(__NR_sendmsg, 2, MSG_FASTOPEN, EOPNOTSUPP),
    DENY_FLAG(__NR_sendmmsg, 3, MSG_FASTOPEN, EOPNOTSUPP),
    /* setsockopt(IPPROTO_TCP, TCP_FASTOPEN_CONNECT) arms the same client-side fast-open path. Deny it;
     * other setsockopt calls (and TCP_FASTOPEN on a listener, which only governs inbound accepts and
     * cannot reach an outside address) are left alone. (level is arg1, optname is arg2.) */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_setsockopt, 0, 6),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, ARG_LO(1)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, IPPROTO_TCP, 0, 3),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, ARG_LO(2)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, TCP_FASTOPEN_CONNECT, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EOPNOTSUPP),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),

    /* Metadata writes that Landlock (ABI <= 8) does not govern: a worker could chmod 000 a protected
     * file of the same uid (e.g. /state/minions.db) or rewrite timestamps/xattrs. Git inside the worktree
     * does need chmod on its own files (loose objects, lock files), so a blanket deny breaks it; path
     * chmod cannot be scoped by seccomp (the path is a pointer). So the path-based chmod forms are routed
     * to the supervisor over the user-notification fd, which allows them only within the writable set and
     * performs them TOCTOU-safely. fchmod on an fd is left allowed: a worker can only hold an fd to a file
     * Landlock let it open, i.e. one in the writable set; it cannot open a protected file at all. The
     * chown, xattr and utimes families are not needed by git or the harnesses, so they are denied. */
#ifdef __NR_chmod
    NOTIFY_NR(__NR_chmod),
#endif
    NOTIFY_NR(__NR_fchmodat),
    NOTIFY_NR(__NR_fchmodat2),
#ifdef __NR_chown
    DENY_NR(__NR_chown, EPERM),
#endif
#ifdef __NR_lchown
    DENY_NR(__NR_lchown, EPERM),
#endif
    DENY_NR(__NR_fchown, EPERM),
    DENY_NR(__NR_fchownat, EPERM),
    DENY_NR(__NR_setxattr, EPERM),
    DENY_NR(__NR_lsetxattr, EPERM),
    DENY_NR(__NR_fsetxattr, EPERM),
    DENY_NR(__NR_removexattr, EPERM),
    DENY_NR(__NR_lremovexattr, EPERM),
    DENY_NR(__NR_fremovexattr, EPERM),
    /* The dirfd-relative forms. setxattrat also works on an O_PATH fd with AT_EMPTY_PATH, and Landlock
     * lets O_PATH open a protected file; a system.posix_acl_access ACL rewrites the mode bits (chmod 000
     * under another name), so these must be denied as well. file_setattr writes the inode flags. */
    DENY_NR(__NR_setxattrat, EPERM),
    DENY_NR(__NR_removexattrat, EPERM),
    DENY_NR(__NR_file_setattr, EPERM),
#ifdef __NR_utime
    DENY_NR(__NR_utime, EPERM),
#endif
#ifdef __NR_utimes
    DENY_NR(__NR_utimes, EPERM),
#endif
#ifdef __NR_futimesat
    DENY_NR(__NR_futimesat, EPERM),
#endif
    DENY_NR(__NR_utimensat, EPERM),

    /* Scheduling and resource controls Landlock scoping does not cover: lowering the nice/affinity/IO
     * priority or limits of same-uid processes outside the sandbox (coordinator, runner). Allow only a
     * target of 0 (the calling process itself); any explicit pid/who is denied. For the PRIO_* and
     * IOPRIO_WHO_* calls the kind of target must also be the process or its own group: PRIO_USER with
     * who 0 would renice every process of the uid. getpriority is limited the same way (no peeking). */
    DENY_UNLESS_SELF_WHICH(__NR_setpriority, PRIO_PROCESS, PRIO_PGRP, EPERM),
    DENY_UNLESS_SELF_WHICH(__NR_getpriority, PRIO_PROCESS, PRIO_PGRP, EPERM),
    DENY_UNLESS_SELF_WHICH(__NR_ioprio_set, IOPRIO_WHO_PROCESS_, IOPRIO_WHO_PGRP_, EPERM),
    DENY_UNLESS_SELF(__NR_sched_setaffinity, 0, EPERM),
    DENY_UNLESS_SELF(__NR_sched_setscheduler, 0, EPERM),
    DENY_UNLESS_SELF(__NR_sched_setattr, 0, EPERM),
    DENY_UNLESS_SELF(__NR_sched_setparam, 0, EPERM),
    DENY_UNLESS_SELF(__NR_prlimit64, 0, EPERM),

    /* TIOCSTI pushes bytes into a terminal's input queue and TIOCLINUX can paste the console selection:
     * with an inherited controlling tty the worker could type into the coordinator's TUI. The command is
     * an unsigned int, so only the low word of arg1 is tested; every other ioctl is allowed. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_ioctl, 0, 5),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, ARG_LO(1)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, TIOCSTI, 2, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, TIOCLINUX, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),

    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    /* socket(): the family and protocol are ints passed by value (no pointer, so no race). */
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, ARG0_LOW),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET, 4, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET6, 3, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_NETLINK, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    /* AF_INET/AF_INET6: Landlock's TCP-connect rule does not cover MPTCP, so IPPROTO_MPTCP is refused
     * (plain TCP, UDP and ICMP-ping sockets keep working; Landlock governs the TCP connects). */
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, ARG_LO(2)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, IPPROTO_MPTCP, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog prog = { (unsigned short)(sizeof f / sizeof f[0]), f };
  /* NEW_LISTENER returns the user-notification fd for the path-chmod rules above; the supervisor keeps it. */
  long lf = syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER, (unsigned long)SECCOMP_FILTER_FLAG_NEW_LISTENER, &prog);
  if (lf < 0) die("seccomp filter refused: %s", strerror(errno));
  return (int)lf;
}

static void confine(const struct rules *r, int abi, int passfd) {
  /* 1. Nothing the runner holds open (DB, sockets, pipes) survives into the worker, except the socket the
   * seccomp listener fd is handed back to the supervisor over (closed below once the fd has been sent). */
  if (passfd > 3 && syscall(__NR_close_range, 3U, (unsigned)passfd - 1, 0U) < 0) die("close_range: %s", strerror(errno));
  if (syscall(__NR_close_range, (unsigned)passfd + 1, ~0U, 0U) < 0) die("close_range: %s", strerror(errno));

  /* 2. Landlock: filesystem allowlist, TCP connect allowlist, signal and abstract-socket scoping. */
  uint64_t handled = fs_handled(abi);
  struct ll_ruleset_attr attr = {
    .handled_access_fs = handled,
    .handled_access_net = LL_NET_CONNECT_TCP,
    .scoped = LL_SCOPE_ABSTRACT_UNIX_SOCKET | LL_SCOPE_SIGNAL,
  };
  int rs = (int)syscall(__NR_landlock_create_ruleset, &attr, sizeof attr, 0U);
  if (rs < 0) die("landlock_create_ruleset: %s", strerror(errno));
  for (size_t i = 0; i < r->nfs; i++) {
    int fd = open(r->fs[i].path, O_PATH | O_CLOEXEC);
    if (fd < 0) {
      if (errno == ENOENT && r->fs[i].optional) continue;
      die("rule path %s: %s", r->fs[i].path, strerror(errno));
    }
    struct stat st;
    if (fstat(fd, &st) < 0) die("rule path %s: %s", r->fs[i].path, strerror(errno));
    struct ll_path_beneath_attr pb = { fs_rights(r->fs[i].access, S_ISDIR(st.st_mode), handled), fd };
    if (pb.allowed_access && syscall(__NR_landlock_add_rule, rs, LL_RULE_PATH_BENEATH, &pb, 0U) < 0)
      die("landlock rule for %s: %s", r->fs[i].path, strerror(errno));
    close(fd);
  }
  for (size_t i = 0; i < r->nports; i++) {
    struct ll_net_port_attr np = { LL_NET_CONNECT_TCP, r->ports[i] };
    if (syscall(__NR_landlock_add_rule, rs, LL_RULE_NET_PORT, &np, 0U) < 0) die("landlock rule for port %u: %s", r->ports[i], strerror(errno));
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) die("no_new_privs: %s", strerror(errno));
  if (syscall(__NR_landlock_restrict_self, rs, 0U) < 0) die("landlock_restrict_self: %s", strerror(errno));
  close(rs);

  /* 3. seccomp last, so none of the setup above is filtered. Hand the notification listener to the
   * supervisor and drop our own copy; the harness must not keep it. */
  int listener = install_seccomp();
  if (send_fd(passfd, listener) < 0) die("could not hand the seccomp listener to the supervisor: %s", strerror(errno));
  close(listener);
  close(passfd);
}

/* ------------------------------------------------------------------ supervisor (stays outside the domain) */

/* ppid and process group from /proc/<pid>/stat; the comm field may contain spaces and parentheses. */
static int proc_stat(pid_t pid, pid_t *ppid, pid_t *pgrp) {
  char path[64], buf[512];
  snprintf(path, sizeof path, "/proc/%d/stat", (int)pid);
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  ssize_t n = read(fd, buf, sizeof buf - 1);
  close(fd);
  if (n <= 0) return -1;
  buf[n] = '\0';
  char *rp = strrchr(buf, ')');
  char state;
  int pp, pg;
  if (!rp || sscanf(rp + 1, " %c %d %d", &state, &pp, &pg) != 3) return -1;
  *ppid = pp;
  *pgrp = pg;
  return 0;
}

/* Signals every process of our group and every direct child (orphans reparent to us as subreaper,
 * including ones that left the group with setsid). Never signals the wrapper itself. */
static void signal_tree(int sig) {
  pid_t self = getpid(), pg = getpgrp();
  DIR *d = opendir("/proc");
  if (!d) return;
  struct dirent *e;
  while ((e = readdir(d))) {
    char *end;
    long pid = strtol(e->d_name, &end, 10);
    pid_t ppid, pgrp;
    if (*end || pid <= 0 || pid == self) continue;
    if (proc_stat((pid_t)pid, &ppid, &pgrp) < 0) continue;
    if (ppid == self || pgrp == pg) kill((pid_t)pid, sig);
  }
  closedir(d);
}

static int supervise(pid_t child, const sigset_t *waitset, int listener, const struct rules *r) {
  int status = 0, have_status = 0, terminating = 0, killing = 0;
  long long deadline = 0;
  /* The blocked signals are read through a signalfd so the same poll() can wait on them and on the chmod
   * notification fd; a slow 1 s tick still drives reaping and the terminate-then-kill deadline. */
  int sfd = signalfd(-1, waitset, SFD_CLOEXEC | SFD_NONBLOCK);
  if (sfd < 0) die("signalfd: %s", strerror(errno));
  for (;;) {
    for (;;) {
      int st;
      pid_t p = waitpid(-1, &st, WNOHANG);
      if (p > 0) { if (p == child) { status = st; have_status = 1; } continue; }
      if (p < 0 && errno == EINTR) continue;
      if (p < 0 && errno == ECHILD) goto done;
      break; /* children remain */
    }
    /* The harness is gone: whatever it left behind is stopped at once. */
    if (have_status) killing = 1;
    if (terminating && !killing && now_ms() >= deadline) killing = 1;
    if (killing) signal_tree(SIGKILL);
    struct pollfd pfd[2];
    pfd[0].fd = sfd; pfd[0].events = POLLIN; pfd[0].revents = 0;
    int li = -1;
    if (listener >= 0) { li = 1; pfd[1].fd = listener; pfd[1].events = POLLIN; pfd[1].revents = 0; }
    int pr = poll(pfd, li >= 0 ? 2 : 1, 1000);
    if (pr < 0) { if (errno == EINTR) continue; die("poll: %s", strerror(errno)); }
    if (pfd[0].revents & POLLIN) {
      struct signalfd_siginfo ssi;
      while (read(sfd, &ssi, sizeof ssi) == (ssize_t)sizeof ssi) {
        int sig = (int)ssi.ssi_signo;
        if ((sig == SIGTERM || sig == SIGINT || sig == SIGHUP) && !terminating) {
          terminating = 1;
          deadline = now_ms() + GRACE_SECONDS * 1000LL;
          signal_tree(SIGTERM);
        }
      }
    }
    if (li >= 0 && (pfd[li].revents & POLLIN)) handle_notif(listener, r);
    if (li >= 0 && (pfd[li].revents & (POLLERR | POLLHUP | POLLNVAL))) { close(listener); listener = -1; }
  }
done:
  close(sfd);
  if (listener >= 0) close(listener);
  if (!have_status) return EXIT_SANDBOX;
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return EXIT_SANDBOX;
}

static int run_wrapped(const struct rules *r, char **cmd) {
  pid_t runner = getppid();
  if (setpgid(0, 0) < 0) die("setpgid: %s", strerror(errno));
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) < 0) die("PR_SET_CHILD_SUBREAPER: %s", strerror(errno));
  if (prctl(PR_SET_PDEATHSIG, SIGTERM, 0, 0, 0) < 0) die("PR_SET_PDEATHSIG: %s", strerror(errno));
  if (getppid() != runner) die("the runner exited before supervision started");

  int abi = landlock_abi();
  if (abi < r->min_abi) die("process isolation unavailable: landlock ABI %d (need %d)", abi, r->min_abi);

  signal(SIGCHLD, SIG_DFL); /* an inherited SIG_IGN would auto-reap the harness and lose its status */
  sigset_t waitset, old;
  sigemptyset(&waitset);
  sigaddset(&waitset, SIGTERM);
  sigaddset(&waitset, SIGINT);
  sigaddset(&waitset, SIGHUP);
  sigaddset(&waitset, SIGCHLD);
  if (sigprocmask(SIG_BLOCK, &waitset, &old) < 0) die("sigprocmask: %s", strerror(errno));

  /* A connected socket pair carries the seccomp notification fd from the confined child back here. */
  int sp[2];
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sp) < 0) die("socketpair: %s", strerror(errno));

  pid_t wrapper = getpid();
  pid_t child = fork();
  if (child < 0) die("fork: %s", strerror(errno));
  if (child == 0) {
    close(sp[0]);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) < 0 || getppid() != wrapper) _exit(EXIT_SANDBOX);
    static const int reset[] = { SIGTERM, SIGINT, SIGHUP, SIGCHLD, SIGPIPE };
    for (size_t i = 0; i < sizeof reset / sizeof reset[0]; i++) signal(reset[i], SIG_DFL);
    sigprocmask(SIG_SETMASK, &old, NULL);
    confine(r, abi, sp[1]);
    execvp(cmd[0], cmd);
    int err = errno;
    say("cannot execute %s: %s", cmd[0], strerror(err));
    _exit(err == ENOENT ? 127 : 126);
  }
  close(sp[1]);
  int listener = recv_fd(sp[0]); /* -1 if the child died before confinement */
  close(sp[0]);
  return supervise(child, &waitset, listener, r);
}

/* ------------------------------------------------------------------ canaries (run inside the sandbox) */

static void report(const char *name, const char *outcome, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  printf("check\t%s\t%s\t", name, outcome);
  vprintf(fmt, ap);
  putchar('\n');
  fflush(stdout);
  va_end(ap);
}

/* A restricted operation: success is an escape; ENOENT/ESRCH mean the probe proved nothing. */
static void expect_denied(const char *name, int ok, int err) {
  if (ok) report(name, "escaped", "operation succeeded");
  else if (err == ENOENT || err == ESRCH) report(name, "error", "target missing (%s)", strerror(err));
  else report(name, "pass", "%s", strerror(err));
}

static void canary_read(const char *path) {
  char name[PATH_MAX + 16];
  struct stat st;
  snprintf(name, sizeof name, "fs.read:%s", path);
  int isdir = stat(path, &st) == 0 && S_ISDIR(st.st_mode);
  int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOCTTY | O_NONBLOCK | (isdir ? O_DIRECTORY : 0));
  int err = errno;
  if (fd >= 0) close(fd);
  expect_denied(name, fd >= 0, err);
}

static void canary_write(const char *path) {
  char name[PATH_MAX + 16], probe[PATH_MAX + 64];
  struct stat st;
  snprintf(name, sizeof name, "fs.write:%s", path);
  if (stat(path, &st) < 0) { report(name, "error", "target missing (%s)", strerror(errno)); return; }
  if (S_ISDIR(st.st_mode)) {
    snprintf(probe, sizeof probe, "%s/.minions-sandbox-canary-%d", path, (int)getpid());
    int fd = open(probe, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
    int err = errno;
    if (fd >= 0) { close(fd); unlink(probe); expect_denied(name, 1, 0); return; }
    if (mkdir(probe, 0700) == 0) { rmdir(probe); report(name, "escaped", "mkdir succeeded"); return; }
    expect_denied(name, 0, err);
  } else {
    /* Open for writing without O_TRUNC and write nothing: an escape changes no content. */
    int fd = open(path, O_WRONLY | O_CLOEXEC | O_NOCTTY | O_NONBLOCK);
    int err = errno;
    if (fd >= 0) close(fd);
    expect_denied(name, fd >= 0, err);
  }
}

static void canary_controls(const char *allow_write, const struct strlist *allow_read) {
  char probe[PATH_MAX + 64];
  snprintf(probe, sizeof probe, "%s/.minions-sandbox-control-%d", allow_write, (int)getpid());
  int fd = open(probe, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (fd < 0) report("control.write-scratch", "error", "cannot write the scratch dir: %s", strerror(errno));
  else {
    int ok = write(fd, "ok\n", 3) == 3;
    close(fd);
    /* The chmod user-notification handler must allow chmod on a file inside the writable set (git needs
     * it on its own worktree files); prove that here before the probe file is removed. */
    if (ok) {
      if (chmod(probe, 0640) == 0) report("control.chmod-scratch", "pass", "chmod inside the scratch dir is allowed");
      else report("control.chmod-scratch", "error", "chmod inside the scratch dir was refused: %s", strerror(errno));
    }
    unlink(probe);
    if (ok) report("control.write-scratch", "pass", "scratch is writable");
    else report("control.write-scratch", "error", "short write in the scratch dir");
  }
  int failed = 0;
  for (size_t i = 0; i < allow_read->n; i++) {
    struct stat st;
    int isdir = stat(allow_read->v[i], &st) == 0 && S_ISDIR(st.st_mode);
    int rfd = open(allow_read->v[i], O_RDONLY | O_CLOEXEC | O_NOCTTY | O_NONBLOCK | (isdir ? O_DIRECTORY : 0));
    if (rfd < 0) { report("control.read", "error", "cannot read %s: %s", allow_read->v[i], strerror(errno)); failed = 1; break; }
    close(rfd);
  }
  if (!failed) report("control.read", "pass", "%zu allowed path(s) readable", allow_read->n);
  int sv[2];
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sv) < 0) report("control.socketpair", "error", "socketpair: %s", strerror(errno));
  else { close(sv[0]); close(sv[1]); report("control.socketpair", "pass", "socketpair(AF_UNIX) allowed (child stdio)"); }
}

static void canary_unix(const char *sock_path, const char *abstract) {
  int s = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (s < 0) {
    report("seccomp.af-unix", "pass", "socket(AF_UNIX): %s", strerror(errno));
    report("unix.path", "pass", "no AF_UNIX socket can be created");
    report("unix.abstract", "pass", "no AF_UNIX socket can be created");
    return;
  }
  close(s);
  report("seccomp.af-unix", "escaped", "socket(AF_UNIX) succeeded");
  /* Connect by a relative name from the socket's directory: sun_path holds only 108 bytes. */
  struct sockaddr_un a;
  memset(&a, 0, sizeof a);
  a.sun_family = AF_UNIX;
  char dir[PATH_MAX];
  snprintf(dir, sizeof dir, "%s", sock_path);
  char *slash = strrchr(dir, '/');
  int rc = -1, err = ENOENT;
  if (slash) {
    *slash = '\0';
    snprintf(a.sun_path, sizeof a.sun_path, "%s", slash + 1);
    if (chdir(dir[0] ? dir : "/") < 0) err = errno;
    else {
      s = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
      rc = s >= 0 ? connect(s, (struct sockaddr *)&a, sizeof a) : -1;
      err = errno;
    }
  }
  if (s >= 0) close(s);
  expect_denied("unix.path", rc == 0, err);
  memset(&a, 0, sizeof a);
  a.sun_family = AF_UNIX;
  size_t len = strlen(abstract);
  memcpy(a.sun_path + 1, abstract, len);
  s = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  rc = s >= 0 ? connect(s, (struct sockaddr *)&a, (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1 + len)) : -1;
  err = errno;
  if (s >= 0) close(s);
  expect_denied("unix.abstract", rc == 0, err);
}

#if defined(__x86_64__)
static void x32_getpid(void) { syscall(X32_SYSCALL_BIT | 39); }
static void compat_socketcall(void) {
  long ret;
  /* i386 socketcall(SYS_SOCKET, NULL) through the compat entry. */
  __asm__ volatile ("int $0x80" : "=a"(ret) : "a"(102L), "b"(1L), "c"(0L) : "memory", "r8", "r9", "r10", "r11");
  (void)ret;
}
static void expect_killed(const char *name, void (*fn)(void)) {
  pid_t p = fork();
  if (p < 0) { report(name, "error", "fork: %s", strerror(errno)); return; }
  if (p == 0) { fn(); _exit(0); }
  int st;
  if (waitpid(p, &st, 0) < 0) { report(name, "error", "waitpid: %s", strerror(errno)); return; }
  if (WIFSIGNALED(st) && WTERMSIG(st) == SIGSYS) report(name, "pass", "process killed by seccomp (SIGSYS)");
  else if (WIFSIGNALED(st)) report(name, "pass", "process killed by signal %d (no such entry)", WTERMSIG(st));
  else report(name, "escaped", "the syscall returned to the caller");
}
#endif

/* The escapee sweep (D3b) finds sandboxed processes by the Seccomp_filters count in /proc/<pid>/status, so
 * the line must be there and count at least the helper's filter. A failed open or read is reported with its
 * errno, apart from a status file that lacks the line: they have different causes and fixes. The whole file
 * is read with read(2) (no stdio line buffer that a long line could split). */
static void canary_seccomp_filters(void) {
  const char *path = "/proc/self/status";
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) { report("proc.seccomp-filters", "error", "cannot open %s: %s", path, strerror(errno)); return; }
  static char buf[65536];
  size_t got = 0;
  for (;;) {
    ssize_t k = read(fd, buf + got, sizeof buf - 1 - got);
    if (k < 0) {
      if (errno == EINTR) continue;
      int e = errno;
      close(fd);
      report("proc.seccomp-filters", "error", "cannot read %s: %s", path, strerror(e));
      return;
    }
    if (k == 0 || got + (size_t)k >= sizeof buf - 1) { got += (size_t)k; break; }
    got += (size_t)k;
  }
  close(fd);
  buf[got] = '\0';
  static const char key[] = "Seccomp_filters:";
  const char *at = NULL;
  for (const char *p = buf; p && *p; p = strchr(p, '\n'), p = p ? p + 1 : NULL)
    if (strncmp(p, key, sizeof key - 1) == 0) { at = p + sizeof key - 1; break; }
  if (!at) { report("proc.seccomp-filters", "error", "no Seccomp_filters line in %s (%zu bytes read)", path, got); return; }
  char *end;
  long n = strtol(at, &end, 10);
  if (end == at) report("proc.seccomp-filters", "error", "unparsable Seccomp_filters line in %s", path);
  else if (n < 1) report("proc.seccomp-filters", "error", "Seccomp_filters is %ld: the helper's filter is not counted", n);
  else report("proc.seccomp-filters", "pass", "%ld", n);
}

static void canary_seccomp(void) {
  unsigned char params[256];
  memset(params, 0, sizeof params);
  long fd = syscall(__NR_io_uring_setup, 1U, params);
  int err = errno;
  /* Require the helper's own ENOSYS, not merely any failure: Docker's profile may return EPERM and mask a
   * regression in the helper's own io_uring rule. */
  if (fd >= 0) { close((int)fd); report("io_uring.setup", "escaped", "io_uring_setup returned a ring"); }
  else if (err == ENOSYS) report("io_uring.setup", "pass", "%s", strerror(err));
  else report("io_uring.setup", "error", "not denied by the helper's own filter (%s)", strerror(err));
#if defined(__x86_64__)
  expect_killed("abi.x32", x32_getpid);
  expect_killed("abi.compat-socketcall", compat_socketcall);
#else
  report("abi.x32", "skip", "no x32 ABI on " ARCH_NAME);
  report("abi.compat-socketcall", "skip", "AArch32 cannot be entered from a 64-bit process");
#endif
  canary_seccomp_filters();
}

static void canary_tcp(unsigned port) {
  int s = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (s < 0) { report("tcp.loopback", "error", "socket(AF_INET): %s", strerror(errno)); return; }
  struct sockaddr_in a;
  memset(&a, 0, sizeof a);
  a.sin_family = AF_INET;
  a.sin_port = htons((uint16_t)port);
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  int rc = connect(s, (struct sockaddr *)&a, sizeof a);
  int err = errno;
  close(s);
  if (rc == 0) report("tcp.loopback", "escaped", "connected to 127.0.0.1:%u", port);
  else if (err == ECONNREFUSED) report("tcp.loopback", "error", "listener on %u refused (fixture missing)", port);
  else report("tcp.loopback", "pass", "127.0.0.1:%u: %s", port, strerror(err));
}

/* TCP Fast Open: a connect-less send to a port outside the allowlist must not reach the listener. */
static void canary_tcp_fastopen(unsigned port) {
  int s = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (s < 0) { report("tcp.fastopen", "pass", "socket(AF_INET): %s", strerror(errno)); return; }
  struct sockaddr_in a;
  memset(&a, 0, sizeof a);
  a.sin_family = AF_INET;
  a.sin_port = htons((uint16_t)port);
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  ssize_t n = sendto(s, "x", 1, MSG_FASTOPEN, (struct sockaddr *)&a, sizeof a);
  int err = errno;
  close(s);
  if (n >= 0) report("tcp.fastopen", "escaped", "sendto(MSG_FASTOPEN) to 127.0.0.1:%u sent %zd byte(s)", port, n);
  else report("tcp.fastopen", "pass", "127.0.0.1:%u: %s", port, strerror(err));
}

/* The helper's own rule must answer: EPERM from its filter, not merely any failure (a kernel without the
 * syscall says ENOSYS, a bad argument EINVAL/EFAULT, a non-tty ENOTTY), so a dropped rule is caught even
 * where the probe could not have done harm. */
static void expect_filtered(const char *name, int ok, int err) {
  if (ok) report(name, "escaped", "operation succeeded");
  else if (err == EPERM) report(name, "pass", "%s", strerror(err));
  else report(name, "escaped", "not denied by the helper's own filter (%s)", strerror(err));
}

/* struct xattr_args (Linux 6.13 UAPI), defined here so the build does not need new headers. */
struct ms_xattr_args { uint64_t value; uint32_t size; uint32_t flags; };

/* Metadata writes Landlock does not cover, on a protected path (a denyWrite dir). Non-destructive: each
 * call uses the path's current values, so a working seccomp filter denies it and a broken one changes
 * nothing visible. */
static void canary_metadata(const char *path) {
  struct stat st;
  if (lstat(path, &st) < 0) {
    static const char *const names[] = { "meta.chmod", "meta.chown", "meta.setxattr", "meta.setxattrat", "meta.removexattrat",
                                         "meta.file_setattr", "meta.utimensat" };
    for (size_t i = 0; i < sizeof names / sizeof names[0]; i++) report(names[i], "error", "target missing (%s)", strerror(errno));
    return;
  }
  expect_denied("meta.chmod", chmod(path, st.st_mode & 07777) == 0, errno);
  expect_denied("meta.chown", chown(path, (uid_t)-1, (gid_t)-1) == 0, errno);
  int xr = setxattr(path, "user.minions-sandbox-canary", "x", 1, 0);
  int xe = errno;
  if (xr == 0) removexattr(path, "user.minions-sandbox-canary");
  expect_denied("meta.setxattr", xr == 0, xe);
  /* The dirfd-relative forms (the system.posix_acl_access route to a mode change). A user.* name keeps the
   * probe harmless; removexattrat names an attribute that does not exist (ENODATA without the rule). */
  struct ms_xattr_args xa = { (uint64_t)(uintptr_t)"x", 1, 0 };
  xr = (int)syscall(__NR_setxattrat, AT_FDCWD, path, 0U, "user.minions-sandbox-canary", &xa, sizeof xa);
  xe = errno;
  if (xr == 0) removexattr(path, "user.minions-sandbox-canary");
  expect_filtered("meta.setxattrat", xr == 0, xe);
  xr = (int)syscall(__NR_removexattrat, AT_FDCWD, path, 0U, "user.minions-sandbox-canary-absent");
  expect_filtered("meta.removexattrat", xr == 0, errno);
  /* A NULL attribute buffer of size 0 is refused by the kernel (EINVAL) before it touches the inode. */
  xr = (int)syscall(__NR_file_setattr, AT_FDCWD, path, (void *)0, (size_t)0, 0U);
  expect_filtered("meta.file_setattr", xr == 0, errno);
  struct timespec times[2] = { st.st_atim, st.st_mtim };
  expect_denied("meta.utimensat", utimensat(AT_FDCWD, path, times, 0) == 0, errno);
}

/* Scheduling and resource controls on a process outside the sandbox (the runner). Non-destructive: each
 * set uses the process's current value, read first through the un-filtered "get" counterpart. */
static void canary_sched(pid_t runner) {
  errno = 0;
  int prio = getpriority(PRIO_PROCESS, runner);
  expect_denied("sched.setpriority", setpriority(PRIO_PROCESS, runner, prio == -1 && errno ? 0 : prio) == 0, errno);
  cpu_set_t set;
  CPU_ZERO(&set);
  if (sched_getaffinity(runner, sizeof set, &set) < 0) CPU_SET(0, &set);
  expect_denied("sched.setaffinity", sched_setaffinity(runner, sizeof set, &set) == 0, errno);
  long cur = syscall(__NR_ioprio_get, 1 /* IOPRIO_WHO_PROCESS */, runner);
  expect_denied("sched.ioprio", syscall(__NR_ioprio_set, 1, runner, cur < 0 ? 0 : cur) == 0, errno);
  struct rlimit rl;
  expect_denied("sched.prlimit", syscall(__NR_prlimit64, runner, RLIMIT_NOFILE, (void *)0, &rl) == 0, errno);
  /* PRIO_USER with who 0 names every process of the uid. Reading it is the harmless probe of that form;
   * setting it is probed with an out-of-range which (the filter allows only PRIO_PROCESS and PRIO_PGRP,
   * so any other value takes the same path; the kernel would answer EINVAL and change nothing). */
  errno = 0;
  int up = getpriority(PRIO_USER, 0);
  expect_filtered("sched.getpriority-user", !(up == -1 && errno), errno);
  expect_filtered("sched.setpriority-which", syscall(__NR_setpriority, 3, 0, 0) == 0, errno);
}

/* Terminal input injection: TIOCSTI/TIOCLINUX on a non-tty (/dev/null) so a dropped rule cannot inject
 * anything; without the rule the kernel says ENOTTY, with it the filter says EPERM. */
static void canary_tty(void) {
  int fd = open("/dev/null", O_RDONLY | O_CLOEXEC);
  if (fd < 0) {
    report("ioctl.tiocsti", "error", "/dev/null: %s", strerror(errno));
    report("ioctl.tioclinux", "error", "/dev/null: %s", strerror(errno));
    return;
  }
  char c = 0;
  expect_filtered("ioctl.tiocsti", ioctl(fd, TIOCSTI, &c) == 0, errno);
  char sub = 0;
  expect_filtered("ioctl.tioclinux", ioctl(fd, TIOCLINUX, &sub) == 0, errno);
  close(fd);
}

/* MPTCP: Landlock's TCP-connect rule does not cover it, so the filter refuses the protocol (EACCES). */
static void canary_mptcp(void) {
  int s = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, IPPROTO_MPTCP);
  int err = errno;
  if (s >= 0) { close(s); report("socket.mptcp", "escaped", "socket(AF_INET, IPPROTO_MPTCP) succeeded"); }
  else if (err == EACCES) report("socket.mptcp", "pass", "%s", strerror(err));
  else report("socket.mptcp", "escaped", "not denied by the helper's own filter (%s)", strerror(err));
}

/* The main canary. Its plan comes from the self-test on stdin (the rules file may be unreadable here). */
static int canary_main(void) {
  struct strlist deny_read = { 0 }, deny_write = { 0 }, allow_read = { 0 };
  int fds[64], nfds = 0;
  pid_t runner = 0;
  unsigned port = 0;
  char sock_path[PATH_MAX] = "", abstract[128] = "", allow_write[PATH_MAX] = "";
  char line[PATH_MAX + 32];
  size_t cap = 64;
  deny_read.v = xmalloc(cap * sizeof(char *));
  deny_write.v = xmalloc(cap * sizeof(char *));
  allow_read.v = xmalloc(cap * sizeof(char *));
  while (fgets(line, sizeof line, stdin)) {
    line[strcspn(line, "\n")] = '\0';
    char *val = strchr(line, '\t');
    if (!val) { if (strcmp(line, "end") == 0) break; continue; }
    *val++ = '\0';
    struct strlist *l = strcmp(line, "deny-read") == 0 ? &deny_read : strcmp(line, "deny-write") == 0 ? &deny_write
                      : strcmp(line, "allow-read") == 0 ? &allow_read : NULL;
    if (l) { if (l->n < cap) l->v[l->n++] = strdup(val); }
    else if (strcmp(line, "runner") == 0) runner = (pid_t)atoi(val);
    else if (strcmp(line, "port") == 0) port = (unsigned)atoi(val);
    else if (strcmp(line, "fd") == 0) { if (nfds < 64) fds[nfds++] = atoi(val); }
    else if (strcmp(line, "sock") == 0) snprintf(sock_path, sizeof sock_path, "%s", val);
    else if (strcmp(line, "abstract") == 0) snprintf(abstract, sizeof abstract, "%s", val);
    else if (strcmp(line, "allow-write") == 0) snprintf(allow_write, sizeof allow_write, "%s", val);
  }
  /* Descriptors first, before this process opens anything that could reuse a number. */
  for (int i = 0; i < nfds; i++) {
    char name[32];
    snprintf(name, sizeof name, "fd.inherited:%d", fds[i]);
    if (fcntl(fds[i], F_GETFD) >= 0) report(name, "escaped", "descriptor %d is open in the worker", fds[i]);
    else report(name, "pass", "%s", strerror(errno));
  }
  canary_controls(allow_write, &allow_read);
  for (size_t i = 0; i < deny_write.n; i++) canary_write(deny_write.v[i]);
  for (size_t i = 0; i < deny_read.n; i++) canary_read(deny_read.v[i]);
  /* Metadata writes and outside-process scheduling: on the first protected dir and the runner. */
  if (deny_write.n) canary_metadata(deny_write.v[0]);
  canary_sched(runner);
  char environ_path[64];
  snprintf(environ_path, sizeof environ_path, "/proc/%d/environ", (int)runner);
  int fd = open(environ_path, O_RDONLY | O_CLOEXEC);
  int err = errno;
  if (fd >= 0) close(fd);
  expect_denied("proc.environ", fd >= 0, err);
  int rc = kill(runner, 0);
  expect_denied("signal.runner", rc == 0, errno);
  rc = kill(getppid(), 0);
  expect_denied("signal.wrapper", rc == 0, errno);
  canary_unix(sock_path, abstract);
  canary_tcp(port);
  canary_tcp_fastopen(port);
  canary_mptcp();
  canary_tty();
  canary_seccomp();
  return 0;
}

/* The lifetime canary: a normal child plus a setsid grandchild that ignore SIGTERM. */
static int canary_lifetime(void) {
  printf("pid\t%d\npid\t%d\n", (int)getpid(), (int)getppid());
  fflush(stdout);
  pid_t c = fork();
  if (c < 0) return 1;
  if (c == 0) {
    setsid();
    signal(SIGTERM, SIG_IGN);
    pid_t g = fork();
    if (g == 0) for (;;) pause();
    printf("pid\t%d\npid\t%d\nready\n", (int)getpid(), (int)g);
    fflush(stdout);
    for (;;) pause();
  }
  for (;;) pause();
}

/* ------------------------------------------------------------------ self-test (plays the runner) */

struct tally { int pass, escaped, error, skip; char first_bad[PATH_MAX + 64]; };

static void tally_line(struct tally *t, char *line) {
  /* check \t name \t outcome \t detail */
  char copy[PATH_MAX + 512];
  snprintf(copy, sizeof copy, "%s", line);
  char *name = strchr(copy, '\t');
  char *outcome = name ? strchr(name + 1, '\t') : NULL;
  char *detail = outcome ? strchr(outcome + 1, '\t') : NULL;
  if (!name || !outcome || !detail) return;
  *outcome++ = '\0';
  *detail++ = '\0';
  name++;
  int bad = 0;
  if (strcmp(outcome, "pass") == 0) t->pass++;
  else if (strcmp(outcome, "skip") == 0) t->skip++;
  else if (strcmp(outcome, "escaped") == 0) { t->escaped++; bad = 1; }
  else { t->error++; bad = 1; }
  if (bad && !t->first_bad[0]) snprintf(t->first_bad, sizeof t->first_bad, "%s %s: %s", name, outcome, detail);
  else if (bad && strcmp(outcome, "escaped") == 0 && !strstr(t->first_bad, " escaped:"))
    snprintf(t->first_bad, sizeof t->first_bad, "%s %s: %s", name, outcome, detail); /* an escape outranks an error */
}

static int port_allowed(const struct rules *r, unsigned p) {
  for (size_t i = 0; i < r->nports; i++) if (r->ports[i] == p) return 1;
  return 0;
}

static void lifetime_test(const char *self, const char *rules_path, struct tally *t) {
  int out[2];
  if (pipe2(out, O_CLOEXEC) < 0) die("pipe: %s", strerror(errno));
  pid_t runner = fork();
  if (runner < 0) die("fork: %s", strerror(errno));
  if (runner == 0) {
    /* The runner stand-in: spawns the wrapper and waits to be SIGKILLed. */
    prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0);
    pid_t w = fork();
    if (w == 0) {
      int nul = open("/dev/null", O_RDONLY);
      if (nul < 0 || dup2(nul, 0) < 0 || dup2(out[1], 1) < 0) _exit(127);
      execl(self, "minions-sandbox", "--rules", rules_path, "--", self, "--canary-lifetime", (char *)NULL);
      _exit(127);
    }
    close(out[0]);
    close(out[1]); /* so the self-test sees EOF if the canary dies before it is ready */
    for (;;) pause();
  }
  close(out[1]);
  FILE *f = fdopen(out[0], "r");
  if (!f) die("fdopen: %s", strerror(errno));
  pid_t pids[8];
  int np = 0, ready = 0;
  char line[128];
  while (fgets(line, sizeof line, f)) {
    int p;
    if (strncmp(line, "ready", 5) == 0) { ready = 1; break; }
    if (sscanf(line, "pid\t%d", &p) == 1 && np < 8) pids[np++] = (pid_t)p;
  }
  fclose(f);
  char out_line[512];
  if (!ready || np < 4) {
    kill(runner, SIGKILL);
    waitpid(runner, NULL, 0);
    snprintf(out_line, sizeof out_line, "check\tlifetime.runner-death\terror\tthe lifetime canary did not start (%d pids)", np);
    printf("%s\n", out_line);
    fflush(stdout);
    tally_line(t, out_line);
    return;
  }
  long long t0 = now_ms();
  kill(runner, SIGKILL);
  waitpid(runner, NULL, 0);
  int alive = np;
  while (now_ms() - t0 < LIFETIME_SECONDS * 1000LL) {
    while (waitpid(-1, NULL, WNOHANG) > 0) {}
    alive = 0;
    for (int i = 0; i < np; i++) if (kill(pids[i], 0) == 0) alive++;
    if (!alive) break;
    usleep(100 * 1000);
  }
  if (alive) {
    for (int i = 0; i < np; i++) kill(pids[i], SIGKILL);
    while (waitpid(-1, NULL, WNOHANG) > 0) {}
    snprintf(out_line, sizeof out_line, "check\tlifetime.runner-death\tescaped\t%d of %d processes alive %d s after the runner was killed", alive, np, LIFETIME_SECONDS);
  } else {
    snprintf(out_line, sizeof out_line, "check\tlifetime.runner-death\tpass\t%d processes gone %lld ms after the runner was killed", np, now_ms() - t0);
  }
  printf("%s\n", out_line);
  fflush(stdout);
  tally_line(t, out_line);
}

static int self_test(const char *rules_path) {
  struct rules r;
  memset(&r, 0, sizeof r);
  alarm(120); /* never hang the caller (doctor, work run) */
  signal(SIGPIPE, SIG_IGN);
  printf("minions-sandbox-selftest\t%d\nversion\t%s\narch\t%s\n", SELFTEST_PROTOCOL, HELPER_VERSION, ARCH_NAME);
  fflush(stdout);
  load_rules(rules_path, &r);
  if (!r.has_selftest) die("rules have no selfTest section");
  int abi = landlock_abi();
  printf("abi\t%d\n", abi);
  if (abi < r.min_abi) {
    printf("result\tunavailable\tlandlock ABI %d (need %d)\n", abi, r.min_abi);
    return 2;
  }
  fflush(stdout);
  char self[PATH_MAX];
  ssize_t sl = readlink("/proc/self/exe", self, sizeof self - 1);
  if (sl <= 0) die("readlink /proc/self/exe: %s", strerror(errno));
  self[sl] = '\0';
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) < 0) die("PR_SET_CHILD_SUBREAPER: %s", strerror(errno));

  /* Fixtures held by this process (the runner): none of them may be reachable from the canary.
   * The unix socket is bound by a relative name from the fixture dir (sun_path holds only 108 bytes). */
  char sock_path[PATH_MAX];
  snprintf(sock_path, sizeof sock_path, "%s/runner.sock", r.fixture_dir);
  if (chdir(r.fixture_dir) < 0) die("fixtureDir %s: %s", r.fixture_dir, strerror(errno));
  struct sockaddr_un ua;
  memset(&ua, 0, sizeof ua);
  ua.sun_family = AF_UNIX;
  snprintf(ua.sun_path, sizeof ua.sun_path, "runner.sock");
  unlink(ua.sun_path);
  int us = socket(AF_UNIX, SOCK_STREAM, 0);
  if (us < 0 || bind(us, (struct sockaddr *)&ua, sizeof ua) < 0 || listen(us, 4) < 0) die("unix socket fixture: %s", strerror(errno));
  if (chdir("/") < 0) die("chdir /: %s", strerror(errno));
  char abstract[64];
  snprintf(abstract, sizeof abstract, "minions-sandbox-selftest-%d", (int)getpid());
  struct sockaddr_un aa;
  memset(&aa, 0, sizeof aa);
  aa.sun_family = AF_UNIX;
  memcpy(aa.sun_path + 1, abstract, strlen(abstract));
  int as = socket(AF_UNIX, SOCK_STREAM, 0);
  if (as < 0 || bind(as, (struct sockaddr *)&aa, (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1 + strlen(abstract))) < 0 || listen(as, 4) < 0)
    die("abstract socket fixture: %s", strerror(errno));
  int ts = -1;
  unsigned port = 0;
  for (int attempt = 0; attempt < 10 && ts < 0; attempt++) {
    struct sockaddr_in ta;
    socklen_t tl = sizeof ta;
    memset(&ta, 0, sizeof ta);
    ta.sin_family = AF_INET;
    ta.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    ts = socket(AF_INET, SOCK_STREAM, 0);
    if (ts < 0 || bind(ts, (struct sockaddr *)&ta, sizeof ta) < 0 || listen(ts, 4) < 0 || getsockname(ts, (struct sockaddr *)&ta, &tl) < 0)
      die("tcp listener fixture: %s", strerror(errno));
    port = ntohs(ta.sin_port);
    if (port_allowed(&r, port)) { close(ts); ts = -1; }
  }
  if (ts < 0) die("could not find a loopback port outside tcpConnectPorts");
  int dfd = open(r.fixture_dir, O_RDONLY | O_DIRECTORY); /* deliberately inheritable */
  if (dfd < 0) die("fixtureDir %s: %s", r.fixture_dir, strerror(errno));

  /* Main canary: through the normal wrapper path (rules parsing, supervisor, confinement, exec). */
  int in[2], out[2];
  if (pipe2(in, O_CLOEXEC) < 0 || pipe2(out, O_CLOEXEC) < 0) die("pipe: %s", strerror(errno));
  pid_t w = fork();
  if (w < 0) die("fork: %s", strerror(errno));
  if (w == 0) {
    if (dup2(in[0], 0) < 0 || dup2(out[1], 1) < 0) _exit(127);
    execl(self, "minions-sandbox", "--rules", rules_path, "--", self, "--canary", (char *)NULL);
    _exit(127);
  }
  close(in[0]);
  close(out[1]);
  FILE *plan = fdopen(in[1], "w");
  if (!plan) die("fdopen: %s", strerror(errno));
  fprintf(plan, "runner\t%d\nport\t%u\nsock\t%s\nabstract\t%s\nallow-write\t%s\n", (int)getpid(), port, sock_path, abstract, r.allow_write);
  fprintf(plan, "fd\t%d\nfd\t%d\nfd\t%d\nfd\t%d\n", us, as, ts, dfd);
  for (size_t i = 0; i < r.allow_read.n; i++) fprintf(plan, "allow-read\t%s\n", r.allow_read.v[i]);
  for (size_t i = 0; i < r.deny_read.n; i++) fprintf(plan, "deny-read\t%s\n", r.deny_read.v[i]);
  for (size_t i = 0; i < r.deny_write.n; i++) fprintf(plan, "deny-write\t%s\n", r.deny_write.v[i]);
  fprintf(plan, "end\n");
  fclose(plan);

  struct tally t;
  memset(&t, 0, sizeof t);
  FILE *cf = fdopen(out[0], "r");
  if (!cf) die("fdopen: %s", strerror(errno));
  char line[PATH_MAX + 512];
  while (fgets(line, sizeof line, cf)) {
    line[strcspn(line, "\n")] = '\0';
    if (strncmp(line, "check\t", 6) != 0) continue;
    printf("%s\n", line);
    tally_line(&t, line);
  }
  fclose(cf);
  fflush(stdout);
  int st = 0;
  while (waitpid(w, &st, 0) < 0 && errno == EINTR) {}
  char exit_line[256];
  if (WIFEXITED(st) && WEXITSTATUS(st) == 0) snprintf(exit_line, sizeof exit_line, "check\tcanary.exit\tpass\tthe canary ran to completion under the rules");
  else snprintf(exit_line, sizeof exit_line, "check\tcanary.exit\terror\tthe wrapped canary ended with %s %d",
                WIFEXITED(st) ? "exit status" : "signal", WIFEXITED(st) ? WEXITSTATUS(st) : WTERMSIG(st));
  printf("%s\n", exit_line);
  fflush(stdout);
  tally_line(&t, exit_line);
  close(us); close(as); close(ts); close(dfd);
  unlink(sock_path);

  lifetime_test(self, rules_path, &t);

  if (t.escaped || t.error) { printf("result\tfail\t%s\n", t.first_bad); return 1; }
  printf("result\tok\t%d checks passed, %d skipped\n", t.pass, t.skip);
  return 0;
}

/* ------------------------------------------------------------------ main */

static void usage(void) {
  fprintf(stderr,
    "usage: minions-sandbox --rules <rules.json> [--] <command> [args...]\n"
    "       minions-sandbox --self-test <rules.json>\n"
    "       minions-sandbox --abi | --version\n");
  _exit(EXIT_SANDBOX);
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--version") == 0) { printf("minions-sandbox %s rules %d selftest %d\n", HELPER_VERSION, RULES_VERSION, SELFTEST_PROTOCOL); return 0; }
  if (argc == 2 && strcmp(argv[1], "--abi") == 0) { printf("%d\n", landlock_abi()); return 0; }
  if (argc == 2 && strcmp(argv[1], "--canary") == 0) return canary_main();
  if (argc == 2 && strcmp(argv[1], "--canary-lifetime") == 0) return canary_lifetime();
  if (argc == 3 && strcmp(argv[1], "--self-test") == 0) return self_test(argv[2]);
  if (argc >= 4 && strcmp(argv[1], "--rules") == 0) {
    int cmd = 3;
    if (strcmp(argv[3], "--") == 0) cmd = 4;
    if (cmd >= argc) usage();
    struct rules r;
    memset(&r, 0, sizeof r);
    load_rules(argv[2], &r);
    return run_wrapped(&r, argv + cmd);
  }
  usage();
  return EXIT_SANDBOX;
}
