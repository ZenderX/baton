---
name: git-diff
description: Compare git branches with structured output — commit log, file stats, and per-file diffs. Use when assessing scope of changes between branches.
---

# Git Branch Diff

Produce a structured comparison between two git branches. Used by the conductor to assess change scope before routing work, and by subagents for targeted context.

## Usage

When invoked, identify the two branches to compare:
- **base**: the target branch (default: `main`)
- **head**: the source branch (default: current branch / `HEAD`)

## Workflow

### 1. Commit Summary

```bash
git log --oneline --no-merges <base>..<head>
```

Report: total commit count and one-line list.

### 2. File Stats

```bash
git diff --stat <base>...<head>
```

Report: files changed, insertions, deletions.

### 3. Changed File List

```bash
git diff --name-status <base>...<head>
```

Categorize files by status: **A**dded, **M**odified, **D**eleted, **R**enamed.

### 4. Per-File Diffs (on request)

Only produce full diffs when explicitly requested or when the conductor needs detailed context for a specific file. For large diffs (>500 lines), summarize changes instead of dumping raw output.

```bash
git diff <base>...<head> -- <file>
```

## Output Format

```
## Branch Diff: <base> → <head>

**Commits:** <N> commits
<one-line commit list>

**Stats:** <N> files changed, <N> insertions(+), <N> deletions(-)

**Changed Files:**
| Status | File |
|--------|------|
| M | src/components/App.vue |
| A | src/utils/helpers.ts |
| D | src/old-module.ts |

**Scope Assessment:** <one-line summary: trivial / moderate / large / architectural>
```

## Scope Assessment Guide

| Criteria | Trivial | Moderate | Large | Architectural |
|----------|---------|----------|-------|---------------|
| Files changed | 1-3 | 4-10 | 11-25 | 25+ |
| Lines changed | <50 | 50-300 | 300-1000 | 1000+ |
| Cross-cutting | No | Partial | Yes | Systemic |

The scope assessment helps the conductor choose the right workflow tier (direct delegation, lightweight, or full).

## Constraints

- Never run `git push`, `git pull`, `git merge`, `git reset`, or any destructive git command
- Read-only analysis only
- For merge conflicts, report them — do not resolve
