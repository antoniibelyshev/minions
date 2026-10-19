# .minions

This directory holds the shared [minions](https://github.com/) configuration for this repository.

- `config.json` — project configuration (profile, policy, limits). Commit it to share the setup.
- Runtime state, backlog, credentials, and Claude login live in per-project Docker volumes on
  each developer's machine, never in this directory.

Run `minions init` after cloning to attach to this configuration, then `minions start`.
Personal values (git identity) are kept on the host, not here.
