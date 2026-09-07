---
name: memory-write
description: How to write a lint-clean memory note — schema, type and tag selection, body structure, wikilinking, and dirty-flag clearing.
---

# Memory Write

Write a well-formed, lint-clean memory note, wikilink it into the graph, and register it in the folder index. The linter enforces frontmatter shape, tag completeness, link resolution, and index presence — this skill ensures you get it right the first time. Writing a note and linking it are one act, not two: a note that lands unlinked is a note the graph cannot surface.

## Schema

Every note requires these frontmatter fields exactly:

```yaml
---
name: <slug>                        # bare slug, matches filename without .md
description: <one-line summary>     # used to judge relevance in future sessions
tags:
  - type/<kind>                     # see Type Selection below
  - topic/<x>                       # what the note is about
  - agent/main                      # always literally `agent/main` — see Tag Conventions
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

**Invalidate, don't delete.** When newer information contradicts a note's claim, don't delete it — write (or update) the newer note with `supersedes: [old-slug]`, add a short banner on the old note pointing at the successor, and cross-link both directions. A contradicted fact keeps its history and gets marked invalid; retrieval prefers the current one. Deleting a note that others cite just turns "outdated" into "broken link".

**Do not detect contradictions by embedding/semantic similarity.** The obvious-looking shortcut doesn't work: measured AUROC 0.59, indistinguishable from chance. A fact that *contradicts* another is on average *more* embedding-similar to it than an unrelated paraphrase — same entities, same predicate shape, opposite polarity. Use explicit `supersedes:` links: a judgment call recorded in frontmatter, not inferred from a vector distance.

**Free signal: the `modified` auto-stamp.** Claude Code v2.1.214+ auto-stamps `modified: <ISO-8601>` into any memory file that **already has frontmatter** (it never adds frontmatter to a file lacking one). It needs no hand-maintenance and is a second, involuntary freshness signal alongside `metadata.updated`.

**`MEMORY.md`'s budget is a hard limit.** The index auto-loads the first **200 lines or 25KB, whichever comes first**; content past that is silently dropped, and since v2.1.210 an over-limit *write* is a hard error. This is why Step 2's one-line-per-entry rule is load-bearing, not stylistic: push detail into the topic file and keep each index line under 150 characters.

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

## Tag Conventions

**Tag values are singular and lowercase** — `topic/book`, never `topic/books` or `topic/Books`. Plural and capitalized variants are distinct tags to Obsidian's search, so mixing them fragments the vocabulary for no benefit ([practicalpkm.com](https://practicalpkm.com/how-to-use-tags-effectively/), retrieved 2026-08-02). This governs the tag *value* only; the frontmatter *key* is always the reserved plural `tags:` ([Obsidian properties](https://obsidian.md/help/properties), retrieved 2026-08-02).

**The `agent/*` tag is always `agent/main`.** Every note lives in the one canonical folder `conductor-main/`, whichever agent authored it, so the tag carries no routing information and must not be used to record provenance — write `agent/main` on every newly authored note regardless of which agent is writing. This matches `memory-review`'s consolidation step, which retags every migrated note to `agent/main`; anything else gets rewritten on the next review pass. Provenance, when it matters, belongs in the note body.

**Nested tags use `/`, and hierarchies stay shallow** (~2 levels, as in the `type/`, `topic/`, `agent/` scaffold above). A parent-tag search matches all children automatically, so `topic/` finds every topic without enumerating them ([Obsidian tags](https://obsidian.md/help/tags), retrieved 2026-08-02). Deeper nesting buys nothing here.

**Machine-filterable facts belong in frontmatter properties, not inline `#tags`.** Obsidian 1.9's Bases (2025) queries YAML frontmatter only and does not read inline tags ([Obsidian properties](https://obsidian.md/help/properties), retrieved 2026-08-02) — so `metadata.type`, `updated`, `freshness`, and `expires` are properties by design, and anything you may later want to filter or sort on goes there rather than into body prose.

**Topics are emergent, not a fixed vocabulary.** Before tagging, survey what's in use: `Grep` with pattern `topic/`, path `.claude/agent-memory`, glob `*.md`, then dedupe the matches to see the established set. Reuse an existing `topic/<x>` when one reasonably fits; mint a new one only when none does — one topic tag per note. A `memory-review` pass reconciles the taxonomy afterwards, so a reasonable choice now is enough.

## Body Structure

**For `feedback` and `project` notes** — lead with the rule or fact, then:
- **Why:** the reason behind it (past incident, constraint, stakeholder ask)
- **How to apply:** when this kicks in and how to judge edge cases

**For all other types** — plain prose; lead with the most actionable information first.

Do not save: code patterns derivable from the codebase, git history, debugging fix recipes, or ephemeral task state. Save only what is non-obvious, durable, and useful to a future agent without the current conversation context.

## Workflow

### Step 1 — Write the note file

Create `<slug>.md` in `.claude/agent-memory/conductor-main/` — the single canonical memory folder (e.g. `.claude/agent-memory/conductor-main/db-pooling.md`). Never create a per-agent folder; the linter reports any note outside `conductor-main/` as `STRAY-LOCATION`.

```markdown
---
name: db-pooling
description: Connection pool must stay below 20 — exceeded limit caused prod OOM in March.
tags:
  - type/feedback
  - topic/tooling
  - agent/main
metadata:
  type: feedback
  updated: 2026-06-30
---

Never set the DB connection pool max above 20 connections.

**Why:** Exceeded this during a load test in March and caused an OOM on prod.
**How to apply:** Any time a DB connection option is configured or reviewed.
```

### Step 2 — Add a one-line pointer to MEMORY.md

Append one line to `.claude/agent-memory/conductor-main/MEMORY.md` (under 150 characters):

```markdown
- [DB Connection Pooling](db-pooling.md) — pool max must stay below 20; OOM incident context
```

The MEMORY.md is the always-loaded index — never write full memory content there. One-line pointers only.

### Step 3 — Wikilink it into the graph

A note is not finished until it is connected. Every note needs at least one link in or out before you call the task done, or the linter's `ORPHAN`/`NO-INBOUND` checks fire.

**Syntax** ([Obsidian links](https://obsidian.md/help/links), retrieved 2026-08-02):

```
[[slug]]                # link by note basename (filename without .md)
[[slug|display text]]   # alias — custom display text
[[slug#heading]]        # link to a heading within the note
[[slug#^blockid]]       # link to a specific block
```

The target is always the note's **basename** — not a path. Casing is ignored by the linter (it compares lowercased), but prefer lowercase slugs.

```
See [[auth-flow-ordering]] for the sequencing constraints.
This was caused by the issue described in [[db-pooling|OOM incident]].
```

**Link liberally, including forward.** Writing `[[paris]]` before `paris.md` exists is normal and officially supported: Obsidian's term is **unresolved link** (not "dangling link"), and it resolves automatically the moment the note is created — no re-linking pass needed ([Obsidian links](https://obsidian.md/help/links), retrieved 2026-08-02). Use forward links freely for topics not yet written; they are breadcrumbs for future connections, a practice Obsidian's own CEO uses deliberately ([stephango.com/vault](https://stephango.com/vault), retrieved 2026-08-02). Scoping this honestly: the *mechanic* is officially documented, the *idiom* is community and practitioner consensus, not official prescription.

**When to link.** On writing a note, link to related notes you know exist plus forward links to ones that should. On updating a note, scan its topic and link notes sharing it. Clustering is emergent — there are no hub files; a well-chosen `topic/*` tag (which renders as its own graph node) plus one same-topic wikilink keeps a note in its cluster.

**Finding inbound links:** `Grep` with pattern `\[\[slug\]\]` and path `.claude/agent-memory/`. Do this before pruning or renaming a note, and before clearing a dirty flag — you need to know which neighbours point at it.

**Before removing a note that has inbound links,** either re-point each linking note to the successor (`[[old-slug]]` → `[[successor-slug]]`) or leave the removed note as a tombstone stub redirecting to `[[successor]]`. Never hard-delete out from under an inbound link.

## Clearing a Dirty Flag

If the note you are rewriting was previously flagged dirty, clear both artifacts once you have verified the content against current repo state. This is the inverse of the flagging operation — same two regions of the file, both edits reversed in the same pass.

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
3. Re-check the note's outbound links: confirm each still points at a current, accurate note; re-point any whose target was renamed or tombstoned; add a link if the updated content now implies a new relationship.
4. Update `metadata.updated` to today.

Never clear a dirty flag without actually verifying the note's claims reflect current state. Never leave the banner line inside the `metadata:` block or half-removed — both artifacts come out together, or neither does.

## Constraints

- Never write memory content into MEMORY.md — only one-line index pointers.
- One concept per file — do not merge unrelated notes to save space.
- Keep `name`, `metadata.type`, and the `type/*` tag in sync.
- `research` notes must carry the `decaying` tag if the fact has a recency dependency.
- Do not save anything already visible in the diff, the code, or CLAUDE.md files.
- A wikilink target is a note basename — never a file path.
- Do not wikilink to `MEMORY.md` files — they are folder indexes accessed by path, not link targets.
