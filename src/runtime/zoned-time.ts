// Wall-clock time in an IANA zone without a dependency (task-68.5, docs/design/unattended-delivery.md decision 7):
// Intl.DateTimeFormat gives the local fields of an instant; the reverse (a local date and time to an instant) is
// found by correcting a UTC guess with the zone offset twice, which is exact outside the DST changes and lands on
// the first valid instant after a spring-forward gap (02:30 on a 02:00 -> 03:00 day becomes 03:30). A repeated
// hour (autumn) resolves to one of its two instants; the digest times (default 08:00) are never inside either.

export interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: string }

const formats = new Map<string, Intl.DateTimeFormat>();

function format(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formats.set(tz, f);
  }
  return f;
}

/** The local calendar fields of `d` in `tz` (month 1-12). Throws a RangeError for an unknown zone. */
export function zonedParts(d: Date, tz: string): ZonedParts {
  const p: Record<string, string> = {};
  for (const x of format(tz).formatToParts(d)) p[x.type] = x.value;
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second), weekday: p.weekday ?? '',
  };
}

/** Milliseconds the zone is ahead of UTC at instant `t` (whole seconds). */
function offsetMs(t: number, tz: string): number {
  const p = zonedParts(new Date(t), tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}

/** The instant of a local date and time in `tz` (month 1-12; day may overflow, as with Date.UTC). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let t = guess - offsetMs(guess, tz);
  t = guess - offsetMs(t, tz);
  return new Date(t);
}

/** The local calendar date `k` days after the local date of `d` (normalised through UTC arithmetic). */
export function localDate(d: Date, tz: string, k = 0): { year: number; month: number; day: number } {
  const p = zonedParts(d, tz);
  const n = new Date(Date.UTC(p.year, p.month - 1, p.day + k));
  return { year: n.getUTCFullYear(), month: n.getUTCMonth() + 1, day: n.getUTCDate() };
}

/** ISO instant of the local midnight that starts the day of `d` in `tz` (the routine's "today"). */
export function localDayStart(d: Date, tz: string): string {
  const x = localDate(d, tz);
  return zonedTimeToUtc(x.year, x.month, x.day, 0, 0, tz).toISOString();
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DDTHH:MM", the local wall-clock time of `d` in `tz` (stable keys and labels). */
export function localStamp(d: Date, tz: string): string {
  const p = zonedParts(d, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** "Tue 27 Oct 08:00", for the owner. */
export function localLabel(d: Date, tz: string): string {
  const p = zonedParts(d, tz);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${p.weekday} ${p.day} ${months[p.month - 1]} ${pad(p.hour)}:${pad(p.minute)}`;
}
