# Git Hygiene Rules

## Rule G1 — Git is read-only for agents
The conductor and all subagents must NEVER mutate git state.
Git state means the index, refs, and history — not working-tree file
contents; ordinary filesystem operations on project files are outside
this rule's scope.
Leave staging, committing, pushing, and history rewriting entirely to the human.
This is also enforced deterministically via `permissions.deny` in `settings.json`.

## Rule G2 — Allowed (read-only)
`git status`, `git diff`, `git log`, `git blame`, `git show`.
Use these freely for verification and diagnosis.
To inspect refs read-only, use `git for-each-ref` / `git show-ref` — the
`git branch`/`git tag` listing forms are now denied (see G3).

## Rule G3 — Forbidden (mutating git subcommands)
`git add`/stage, `git commit`, `git push`, `git pull`, `git fetch`, `git reset`,
`git restore`, `git checkout`/`git switch` (working-tree changes), `git rebase`,
`git merge`, `git cherry-pick`, `git revert`, `git clean`, `git rm`, `git mv`,
`git commit-tree`, `git update-ref`, plus the dual-mode subcommands
`git branch`, `git tag`, `git stash`, `git worktree`, `git remote`, `git notes`.
Never run these. All are hard-blocked by `permissions.deny` in `settings.json`.
The dual-mode subcommands are denied wholesale — this also blocks their
read-only listing forms (e.g. `git branch -a`, `git stash list`, `git remote -v`);
use `git for-each-ref` / `git show-ref` to inspect refs read-only instead.
