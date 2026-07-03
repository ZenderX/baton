---
name: memory-write
description: How to write a lint-clean memory note — schema, two-step process, type selection, body structure, and dirty-flag clearing. Pairs with obsidian-links.
---

# Memory Write

Write a well-formed, lint-clean memory note and register it in the folder index. The linter enforces frontmatter shape, tag completeness, and index presence — this skill ensures you get it right the first time.

## Schema

Every note requires these frontmatter fields exactly:

```yaml
---
name: <slug>                        # bare slug, matches filename without .md
description: <one-line summary>     # used to judge relevance in future sessions
tags:
  - type/<kind>                     # see Type Selection below
  - topic/<x>                       # what the note is about
  - agent/<agent-name>              # which agent authored it
metadata:
  type: <kind>                      # must match the type/* tag suffix exactly
  updated: <YYYY-MM-DD>             # today's date
---
```

`name` must match the filename exactly (without `.md`). `metadata.type` must match the `type/*` tag suffix — both must agree or the note is inconsistent.

## Type Selection

| Type | Tag | Use when |
|------|-----|----------|
| `user` | `type/user` | User role, background, stated preferences |
| `feedback` | `type/feedback` | Guidance from user — what to avoid or keep doing |
| `project` | `type/project` | Ongoing work, goals, decisions, deadlines |
| `reference` | `type/reference` | Pointers to external systems or resources |
| `planning` | `type/planning` | Architectural insights, dependency-ordering gotchas |
| `implementation` | `type/implementation` | Non-obvious implementation decisions, integration gotchas |
| `research` | `type/research` | External library findings, version facts (add `decaying` tag; linter flags when stale) |
| `review` | `type/review` | Recurring defect patterns, project-specific quality bars |

## Topic Selection

Topics are dynamic, not a fixed vocabulary. Before tagging, survey what's already in use:

```bash
grep -rh "topic/" .claude/agent-memory --include="*.md" | sort -u
```

Reuse an existing `topic/<x>` when one reasonably fits. Mint a new `topic/<x>` only when none does — one topic tag per note. Don't agonize over the perfect fit: the `memory-subagent` reconciles the taxonomy after each task (merging synonyms, cross-linking same-topic notes), so a reasonable choice now is enough.

## Body Structure

**For `feedback` and `project` notes** — lead with the rule or fact, then:
- **Why:** the reason behind it (past incident, constraint, stakeholder ask)
- **How to apply:** when this kicks in and how to judge edge cases

**For all other types** — plain prose; lead with the most actionable information first.

Do not save: code patterns derivable from the codebase, git history, debugging fix recipes, or ephemeral task state. Save only what is non-obvious, durable, and useful to a future agent without the current conversation context.

## Workflow

### Step 1 — Write the note file

Create `<slug>.md` in the correct agent folder (e.g. `.claude/agent-memory/implement-subagent/db-pooling.md`):

```markdown
---
name: db-pooling
description: Connection pool must stay below 20 — exceeded limit caused prod OOM in March.
tags:
  - type/feedback
  - topic/tooling
  - agent/implement-subagent
metadata:
  type: feedback
  updated: 2026-06-30
---

Never set the DB connection pool max above 20 connections.

**Why:** Exceeded this during a load test in March and caused an OOM on prod.
**How to apply:** Any time a DB connection option is configured or reviewed.
```

### Step 2 — Add a one-line pointer to MEMORY.md

Append one line to `.claude/agent-memory/<agent>/MEMORY.md` (under 150 characters):

```markdown
- [DB Connection Pooling](db-pooling.md) — pool max must stay below 20; OOM incident context
```

The MEMORY.md is the always-loaded index — never write full memory content there. One-line pointers only. After writing, add `[[slug]]` cross-links in related notes (see the `obsidian-links` skill for mechanics).

## Clearing a Dirty Flag

If the note you are rewriting was previously flagged dirty, clear both artifacts once you have verified the content against current repo state:

1. Remove `dirty: <date>` and `dirty_reason: "..."` from the `metadata` block.
2. Remove the banner line from the top of the body:
   `> ⚠️ **DIRTY (since <YYYY-MM-DD>):** may be stale — re-evaluate against current state and re-link before relying on this. Reason: <reason>.`
3. Update `metadata.updated` to today.

Never clear a dirty flag without actually verifying the note's claims reflect current state.

## Constraints

- Never write memory content into MEMORY.md — only one-line index pointers.
- One concept per file — do not merge unrelated notes to save space.
- Keep `name`, `metadata.type`, and the `type/*` tag in sync.
- `research` notes must carry the `decaying` tag if the fact has a recency dependency.
- Do not save anything already visible in the diff, the code, or CLAUDE.md files.
