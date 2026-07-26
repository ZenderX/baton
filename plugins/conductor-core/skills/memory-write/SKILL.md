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

## Freshness & Staleness

All of the fields below are **optional** additions to the `metadata:` block above — the existing linter and every existing note stay valid without them. A note with no `freshness` field is `timeless` by default.

```yaml
metadata:
  type: user|feedback|project|reference
  updated: YYYY-MM-DD
  freshness: timeless|slow|medium|fast   # optional; default timeless
  expires: YYYY-MM-DD                    # optional; only meaningful if freshness != timeless
  supersedes: [other-note-slug]          # optional; invalidate-don't-delete
```

**Freshness classes:**

| Class | Decay window | Use for |
|---|---|---|
| `timeless` (default) | none | decisions, rationale, engineering lessons |
| `slow` | weeks-months | policy, conventions |
| `medium` | days | versions, project state |
| `fast` | hours-days | prices, live facts |

**Invalidate, don't delete.** When a note's claim is contradicted by newer information, don't delete it — write (or update) the newer note with `supersedes: [old-slug]`, and mark the old note superseded: add a short banner pointing at the successor and cross-link both directions. This mirrors Zep/Graphiti's bi-temporal memory model — a contradicted fact keeps its history and gets marked invalid; retrieval prefers the current one. Deleting a note that other notes cite just turns "outdated" into "broken link."

**Do not build contradiction detection from embedding/semantic similarity.** This is the obvious-looking shortcut for "does this new note contradict an old one" and it doesn't work: measured AUROC 0.59, statistically indistinguishable from chance. A fact that *contradicts* another is on average *more* embedding-similar to it than an unrelated paraphrase is — same entities, same predicate shape, opposite polarity. Use explicit `supersedes:` links instead: a judgment call recorded deterministically in frontmatter, not inferred from a vector distance.

**Free signal: the `modified` auto-stamp.** Claude Code v2.1.214+ auto-stamps a `modified: <ISO-8601>` field into any memory file that **already has frontmatter** — it never adds frontmatter to a file that lacks one. Any note you edit that already has a `metadata:` block picks this up automatically; you don't need to hand-maintain it, and it's a second, involuntary freshness signal alongside `metadata.updated`.

**`MEMORY.md`'s budget is a hard limit, not a guideline.** The index auto-loads the first **200 lines or 25KB, whichever comes first** — content past that is silently dropped from context, and since v2.1.210 an over-limit *write* to `MEMORY.md` is a hard error rather than a silent truncation. This is why the one-line-per-entry rule in Step 2 below is load-bearing, not stylistic: push all detail into the topic file, keep the index line itself under 150 characters.

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

If the note you are rewriting was previously flagged dirty, clear both artifacts once you have verified the content against current repo state. This is the inverse of the flagging operation in `memory-subagent` §3 — same two regions of the file, both edits reversed in the same pass.

Before (a correctly dirty-flagged note):

```yaml
---
name: some-note
metadata:
  type: project
  updated: 2026-07-20
  dirty: 2026-07-26
  dirty_reason: "neighbor [[changed-slug]] changed on 2026-07-26"
---
> ⚠️ **DIRTY (since 2026-07-26):** may be stale — re-evaluate against current state and re-link before relying on this. Reason: neighbor [[changed-slug]] changed on 2026-07-26.

Existing body text, now re-verified.
```

After (both `dirty` keys removed from `metadata:`, the banner line removed from the body, `updated` bumped — the closing `---` is untouched throughout):

```yaml
---
name: some-note
metadata:
  type: project
  updated: 2026-07-26
---

Existing body text, now re-verified.
```

Steps:

1. Remove `dirty: <date>` and `dirty_reason: "..."` from the `metadata` block.
2. Remove the banner line from the top of the body:
   `> ⚠️ **DIRTY (since <YYYY-MM-DD>):** may be stale — re-evaluate against current state and re-link before relying on this. Reason: <reason>.`
3. Update `metadata.updated` to today.

Never clear a dirty flag without actually verifying the note's claims reflect current state. Never leave the banner line inside the `metadata:` block or half-removed — both artifacts come out together, or neither does.

## Constraints

- Never write memory content into MEMORY.md — only one-line index pointers.
- One concept per file — do not merge unrelated notes to save space.
- Keep `name`, `metadata.type`, and the `type/*` tag in sync.
- `research` notes must carry the `decaying` tag if the fact has a recency dependency.
- Do not save anything already visible in the diff, the code, or CLAUDE.md files.
