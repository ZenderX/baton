---
name: memory-review
description: "Audit the .claude/agent-memory/ vault for accuracy, staleness, and graph integrity. Ingest stray notes, prune stale ones, reorganize MEMORY.md. Runs the deterministic linter first, then applies judgment. Safe: no blind deletion."
---

# Memory Vault Review

Three jobs, in order:

1. **Ingest** — pull stray notes into the canonical folder, and verify what's already there against current repo state.
2. **Prune** — remove stale, superseded, and duplicate notes without breaking inbound links.
3. **Reorganize `MEMORY.md`** — keep the always-loaded index accurate and within budget.

The linter handles mechanics; this skill handles the judgment the linter cannot.

## Usage

Invoke when:
- The linter reports strays, orphans, stale notes, or contradictions
- A significant architectural change may have invalidated existing memories
- Monthly cadence for routine vault hygiene

This skill is preloaded into the `memory` agent. The conductor delegates a vault review/stewardship pass to that agent (the same way it delegates any other brief), and the agent runs this procedure — either with `pwsh ${CLAUDE_PLUGIN_ROOT}/scripts/memory-lint.ps1` results already in hand, or by running the full workflow below itself.

**This skill has no authority over agent, skill, or rule files.** It reads and writes memory notes under `.claude/agent-memory/` and nothing else. A vault insight that seems to belong in an agent definition gets surfaced to the user in the summary, never written there.

## Workflow

### 1. Run the Linter

```bash
pwsh ${CLAUDE_PLUGIN_ROOT}/scripts/memory-lint.ps1
```

Capture the full output. Any integrity errors (dead index entries, stray locations) must be resolved before judgment work.

If integrity errors exist, run:
```bash
pwsh ${CLAUDE_PLUGIN_ROOT}/scripts/memory-lint.ps1 -Fix
```

Then re-run in report mode and confirm exit 0 before proceeding.

Note: `-Fix` also regenerates `.obsidian/graph.json`'s topic color groups automatically (one deterministic color per `topic/*` tag in use, ordered ahead of the static `type/*` fallback colors) — graph colorization requires no manual edits.

### 2. Consolidate Stray Notes

**A directory containing a `MEMORY.md` that is not `conductor-main/` is stray memory.** That is the whole rule. Detection keys on the `MEMORY.md` artifact, not on folder names — there is no agent-name roster and no per-agent branching, so the check is rename-proof and needs no maintenance as agents come and go. The vault root itself is not stray; every other `MEMORY.md`-bearing directory the linter reports as `STRAY-LOCATION` is.

Everything migrates into `.claude/agent-memory/conductor-main/` — the sole canonical folder. Create it if it does not exist. For each stray folder:

1. **Move the notes.** Every file except `MEMORY.md` moves into `conductor-main/`.
   - **Same-slug collision:** the `conductor-main/` note wins. Merge any genuinely new information from the stray copy into the canonical note's body, then delete the stray copy. If the two notes are unrelated and merely share a slug, rename the stray one to a distinct slug, update its `name:` frontmatter to match the new filename, and move it in under that name.
   - **No collision:** move as-is.
2. **Retag.** Rewrite each migrated note's `agent/*` tag to `agent/main`.
3. **Preserve inbound links.** Before and after the move, wikilinks resolve by basename, not path, so a plain move keeps `[[links]]` intact. A *rename* does not — if step 1 renamed a note, `Grep` for `\[\[<old-slug>\]\]` across `.claude/agent-memory/` and re-point every inbound link to the new slug.
4. **Merge the index.** Fold every entry from the stray folder's `MEMORY.md` into `conductor-main/MEMORY.md`, skipping entries that already point at an equivalent file. One line per entry. Each folded entry must point at the note's **final post-move filename** — rewrite the link target (and title, if it names the old slug) for any note renamed in step 1. A verbatim fold after a rename creates an `INDEX-DEAD-LINK` error.
5. **Dirty-flag every migrated note.** Add `dirty: <YYYY-MM-DD>` and `dirty_reason: "migrated from stray <path> on <YYYY-MM-DD>; not yet validated"` to `metadata:`, and the matching banner line as the first line of the body (see `memory-write` for the exact two-edit pattern and the YAML-corruption failure mode it avoids). For a same-slug merge, flag the *surviving canonical note* with reason `"merged from stray <path> on <YYYY-MM-DD>; not yet validated"`.
6. **Prune the emptied folder.** Delete the stray folder and any ancestor directories the move left empty. Never leave a folder half-migrated — if a file cannot be moved, say so plainly in the summary rather than silently abandoning it.

**Files that are not memory notes** (no frontmatter, or clearly not vault content) are surfaced to the user in the summary and left where they are. Never auto-move them.

The vault legitimately contains only `.md` notes, `MEMORY.md` indexes, and `.obsidian/`. Anything else is litter, which the linter reports as `LITTER`. Delete `*.tmp` files outright — they are residue of a temp-file pattern nothing here should be using, and `-Fix` removes them for you. Other unknown non-note files stay surfaced-and-left-in-place per the rule above.

### 3. Plan the Epoch

Snapshot the full flagged/dirty worklist once, from step 1's linter run. That snapshot is the entire work plan for this pass — nothing joins it later.

Every note edited during the pass is **settled**: never re-verified, re-flagged, or rewritten again in the same pass, even if a later edit changes one of its neighbours. Without this, a pass processing flagged notes in arbitrary order rewrites a note, then its neighbour, then decides the first needs touching again — cycles and rework that never converge. A genuine late finding that would invalidate a settled note goes into the summary's **Deferred** list, to be picked up by the next pass; it does not reopen the note.

Within a linked cluster of dirty notes, do all the reads first — verify the whole cluster against repo state and decide survivors and merges — then write each note exactly once.

Within-pass edits never dirty-flag neighbours. Dirty flags originate only from a conductor-briefed propagation pass, which is the same reason a review pass is terminal (step 10).

### 4. Triage the Linter Report

For each flagged item, classify:

| Flag | Judgment Action |
|------|----------------|
| `ORPHAN` | Check whether the note has value; if yes, cross-link to a related note or MEMORY.md; if not, prune with link-survival rule |
| `STALE` | Read note; verify claim against current repo state; update body + `metadata.updated`, or prune |
| `DIRTY` | Read note → verify against current repo state → check for duplicates (Grep the vault for same-topic/overlapping notes); if a duplicate exists, merge the relevant content into one survivor and delete the other (link-survival rule, step 8, applies to the deleted note's inbound links) → re-link outbound links → clear the dirty flag on the survivor; or escalate if the content cannot be verified |
| `MISSING-TAG` | Add missing tags; classify correctly |
| `MISSING-UPDATED` | Set `metadata.updated` to today if the content is still accurate; otherwise prune |
| `DUPLICATE-BASENAME` | Keep the more recent or more specific note; tombstone or delete the other |
| `TOPIC-SINGLETON` | Judge: merge into an established topic (retag + cross-link) if it's a synonym/fragment; keep if genuinely emerging — then add a same-topic link when a second note arrives |
| `TAG-SPRAWL` | A tag (topic or ad hoc) is used by exactly one note; same judgment as `TOPIC-SINGLETON` |
| `NO-INBOUND` | Note has outbound links but nothing links back; add a `[[wikilink]]` from a related note, or fold it into MEMORY.md |
| `EXPIRED` | `metadata.expires` is past due; re-verify the claim, refresh `updated`/`expires`, or prune per the freshness schema in `memory-write` |
| `STALE-ORPHAN` | Over 180 days old AND no inbound links — the two-factor dead-weight signal (age alone is not sufficient reason to act); verify against current state or prune with the link-survival rule |
| `NAME-MISMATCH` | `name:` frontmatter disagrees with the filename; decide which is authoritative and fix the other |
| `TYPE-MISMATCH` | `metadata.type` disagrees with the `type/*` tag; retag both to whichever type actually fits (see Fix Categorization) |
| `BROKEN-LINK` / `BROKEN-LINK-NAME` | Warnings, not gate-blockers. A link to a slug that was never written is an intentional forward link — leave it. A link whose target you can tell was removed gets re-pointed to the successor or to a tombstone |

### 5. Fix Categorization

The linter only checks that `type/*` and `topic/*` tags are *present* — it cannot judge whether they're *correct*. For every note flagged during triage, or otherwise touched during this review, verify categorization by reading the note:

- **Type:** confirm `metadata.type`, the `type/*` tag, and the note's actual content all agree. If a note tagged `type/research` is really recording feedback (or vice versa), retag it — update the `type/*` tag and `metadata.type` together, and adjust `description` if it no longer matches.
- **Topic:** confirm the `topic/*` tag actually describes the content. If it's a synonym or near-duplicate of an established topic (e.g. `topic/state-mgmt` vs an existing `topic/state-management`), retag to the established one rather than letting the taxonomy fragment.
- After any retag, update `metadata.updated` to today.

### 6. Verify Against Repo State

For each note flagged as stale, freshly migrated, or carrying a load-bearing claim, verify it reflects current reality: `Grep` with pattern `<keyword>` and path `.claude/` to check whether the described file/pattern still exists, and cross-check recent history:

```bash
git log --oneline -10
```

If the memory is accurate: update `metadata.updated` to today.
If it's outdated: update the body OR prune with the link-survival rule below.

**Clearing a dirty flag.** When a note's claims are verified (or updated) and its outbound links confirmed accurate, remove both `dirty` and `dirty_reason` from `metadata:`, remove the banner line from the top of the body, and bump `metadata.updated` to today. Both edits reverse in the same pass; the closing `---` is never touched. `memory-write` carries the before/after frames.

Never clear without verifying. Never leave the banner line inside the `metadata:` block — that is invalid YAML, not a partially-cleared flag.

**Dedup obligation for dirty notes:** before clearing a dirty flag, check whether the note duplicates another already in the vault. This is the common case for notes arriving dirty via step 2's migration, where the same content may already exist under a different slug. `Grep` the note's key terms across `.claude/agent-memory/`; if a duplicate exists, merge into one survivor, delete the other via the link-survival rule (step 8), and only then clear the flag on the survivor.

### 7. Reconcile Contradictions

If two notes make conflicting claims about the same topic, surface the conflict — don't average it:
1. Determine which is more recent or more battle-tested (check `metadata.updated`, git log).
2. Keep the authoritative note; update it to acknowledge the resolved conflict.
3. Tombstone the superseded note.

### 8. Connect Orphans and Prune with Link Survival

Before pruning an orphan, check whether it is genuinely valueless or merely disconnected. If valuable: add a `[[wikilink]]` from a related note, or add it to `MEMORY.md`. If not: prune.

**Never hard-delete a note that has inbound `[[wikilinks]]` without doing one of these first.** Find them with `Grep`, pattern `\[\[<slug>\]\]`, path `.claude/agent-memory/`.

**Option A — Re-point:** edit each linking note to target a successor instead.

**Option B — Tombstone stub:** replace the pruned note's body with:

```yaml
---
name: <original-slug>
description: Tombstone — superseded by <successor-slug>.
tags:
  - type/tombstone
  - topic/<x>
  - agent/main
metadata:
  type: tombstone
  updated: <YYYY-MM-DD>
---

Superseded by [[successor-slug]]. Removed because: <reason>.
```

### 9. Reorganize MEMORY.md

`conductor-main/MEMORY.md` is the always-loaded index and the deliverable of this pass. After every add, rename, merge, and prune above:

- One line per note, under 150 characters, pointing at the note's current filename.
- Every note present in the folder appears exactly once (the linter's `FILE-NOT-INDEXED` and `INDEX-DEAD-LINK` checks catch misses).
- Group related entries together and drop entries for notes that no longer exist.
- Keep the whole file within its hard budget: the first **200 lines or 25KB, whichever comes first**, auto-loads — past that is silently dropped, and an over-limit write is a hard error. If the index is approaching either ceiling, tighten entry wording; the fix is never to let it overflow.

### 10. Final Lint

Run the linter once more to confirm the vault is clean:

```bash
pwsh ${CLAUDE_PLUGIN_ROOT}/scripts/memory-lint.ps1
```

Expected output: `OK  Vault is clean.` with exit code 0.

**A review pass is terminal — never follow it with a propagation pass**, whether run inline or requested back from the conductor. Propagation would dirty-flag the very notes this review just verified, converting a clean vault back into noise for the next reviewer. State the suppression explicitly in the summary. If specific notes were left genuinely unverified, flag those individually instead of propagating wholesale.

## Output Format

```
## Memory Review Summary

**Linter run:** <N> errors, <N> warnings before review
**After fixes:** <exit code and clean/dirty status>

**Ingested:**
- Strays found: <N MEMORY.md-bearing folders outside conductor-main — or "none">
- Notes migrated: <N, by slug — or "n/a">
- Same-slug merges: <N canonical notes merged into, by slug — or "n/a">
- Folders pruned: <N stray folders + empty ancestors removed — or "n/a">
- Non-note files surfaced (left in place): <paths — or "none">

**Pruned:**
- Tombstoned: <file> — <reason>; inbound re-pointed to [[<successor>]]
- Deleted: <file> — <reason>; had no inbound links
- Reconciled: kept <file-A> over <file-B>; <file-B> tombstoned
- Litter removed: <N *.tmp files — or "none">

**Reorganized:**
- MEMORY.md entries added / rewritten / removed: <N / N / N>
- Index size: <N lines, N KB> (budget: 200 lines / 25KB)

**Verified:** <N notes checked against repo state; N dirty flags cleared>
**Settled:** <N notes edited exactly once; none reopened>
**Connected:** added [[<link>]] in <file> to resolve orphan
**Vault status:** Clean / <N> items deferred for human judgment
**Propagation:** Suppressed — a review pass is terminal (step 10)
**Deferred:** <items needing human input, and why>
```

## Constraints

- Edit nothing outside `.claude/agent-memory/`. Agent, skill, and rule files are not this skill's to touch — surface the suggestion to the user instead.
- `conductor-main/` is the only canonical memory folder. Never create a per-agent folder.
- Never delete a file with inbound `[[wikilinks]]` without first tombstoning or re-pointing.
- Never overwrite a note's body based solely on linter output — verify against repo state first.
- When uncertain whether a memory is stale, update `metadata.updated` and add a note in the body rather than pruning.
- Do not prune a note merely because it is old; prune when it is inaccurate or superseded.
- Never follow a review pass with a propagation pass — state the suppression in the summary (step 10).
- Never reopen a note already edited in this pass — a late finding goes to **Deferred** (step 3).
