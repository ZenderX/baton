# Upstream provenance

This directory holds vendored third-party content, copied unmodified.

- Source: https://github.com/thedotmack/sequential-thinking-skill
- Commit: `d0fd5d4257aeb9a8622fffe9082379a787279dba` (2026-02-27T03:29:46Z, "perf: switch from npx tsx to bun")
- License: MIT, Copyright (c) 2026 thedotmack; see `LICENSE` in this directory.

## Vendored files

| Here | Upstream path |
|---|---|
| `SKILL.md` | `sequential-thinking/SKILL.md` |
| `references/example-session.md` | `sequential-thinking/references/example-session.md` |
| `scripts/think.ts` | `sequential-thinking/scripts/think.ts` |
| `LICENSE` | `LICENSE` |

Left out: upstream root `README.md` and `.gitignore`.

Each vendored file's `git hash-object` equals its upstream blob SHA at the commit above. To update, re-fetch at a new commit and update this file; do not edit the vendored files.

## Use in this repo

This repo's agents follow the skill's thought protocol inline in their own reasoning and never run `scripts/think.ts`, which needs the Bun runtime.
