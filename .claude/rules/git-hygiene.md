# Git Hygiene Rules

## Rule G1 — Git is read-only for agents
The conductor and all subagents must NEVER mutate git state.
Leave staging, committing, pushing, and history rewriting entirely to the human.
This is also enforced deterministically via `permissions.deny` in `settings.json`.

## Rule G2 — Allowed (read-only)
`git status`, `git diff`, `git log`, `git blame`, `git show`, `git branch` (listing only).
Use these freely for verification and diagnosis.

## Rule G3 — Forbidden (mutating)
`git add`/stage, `commit`, `push`, `pull`, `fetch`, `reset`, `restore`,
`checkout`/`switch` (working-tree changes), `stash`, `rebase`, `merge`,
`cherry-pick`, `revert`, `clean`, `rm`, `mv`, `tag`, `branch` (creation/deletion),
`commit-tree`, `update-ref`.
Never run these. Most are hard-blocked by `permissions.deny`; a few (e.g.
`git branch <name>`, which can't be denied without also blocking branch listing)
rely on this rule alone — a future PreToolUse hook can close that gap.
