---
name: memory-review
description: "Audit the .claude/agent-memory/ vault for accuracy, staleness, and graph integrity. Runs the deterministic linter first, then applies judgment to verify, reconcile, and prune. Safe: no blind deletion."
---

# Memory Vault Review

Audit the agent memory vault for accuracy against current repo state, reconcile contradictions, connect orphans, and prune stale or superseded notes. The linter handles mechanics; this skill handles judgment.

## Usage

Invoke when:
- The linter reports orphans, stale notes, or contradictions
- A significant architectural change may have invalidated existing memories
- Monthly cadence for routine vault hygiene

The conductor invokes this skill with `pwsh scripts/memory-lint.ps1` results in hand, or triggers the full workflow below.

## Workflow

### 1. Drain the Promotion Queue (workbench only)

This step runs only inside the canonical workbench. Workbench identity is marker-based, not path-based: a repo is the canonical workbench when its root contains **both** `.claude-plugin/marketplace.json` **and** `scripts/sync-global.ps1` (see the workbench-guard in step 10 for the full rationale). This check works identically across machines and OSes because no path is ever hardcoded — it tests file presence, not a specific location. Outside the workbench, skip this step entirely.

Read every file in `~/.claude/agent-memory/promotion-queue/`. If the directory doesn't exist or is empty, skip silently — this is the common case.

For each queued file:
1. Read its proposed instruction text, target file, source project (name/path), date, and provenance note-slug.
2. Judge the proposal:
   - **Accept:** make the canonical edit to the named target under `plugins/conductor/agents/`, `plugins/<plugin>/skills/<skill>/SKILL.md`, or the `## Operating Rules` section of `plugins/conductor/agents/main.md` for a rule, in this workbench; if the source project is locally reachable, annotate the source note per the promotion-annotation convention in step 10.
   - **Reject:** make no edit; record the reason in the review summary.
3. Delete the queue file once resolved, whether accepted or rejected.

### 2. Run the Linter

```bash
pwsh scripts/memory-lint.ps1
```

Capture the full output. Any integrity errors (broken links, dead index entries) must be resolved before judgment work.

If integrity errors exist, run:
```bash
pwsh scripts/memory-lint.ps1 -Fix
```

Then re-run in report mode and confirm exit 0 before proceeding.

Note: `-Fix` also regenerates `.obsidian/graph.json`'s topic color groups automatically (one deterministic color per `topic/*` tag in use, ordered ahead of the static `type/*` fallback colors) — graph colorization requires no manual edits.

### 3. Triage the Linter Report

For each flagged item, classify:

| Flag | Judgment Action |
|------|----------------|
| `ORPHAN` | Check whether the note has value; if yes, cross-link to a related note or MEMORY.md; if not, prune with link-survival rule |
| `STALE` | Read note; verify claim against current repo state; update body + `metadata.updated`, or prune |
| `DIRTY` | Read note → verify against current repo state → re-link outbound links → clear the dirty flag (remove `dirty`/`dirty_reason` frontmatter keys and banner); or escalate if the content cannot be verified |
| `MISSING-TAG` | Add missing tags; classify correctly |
| `MISSING-UPDATED` | Set `metadata.updated` to today if the content is still accurate; otherwise prune |
| `DUPLICATE-BASENAME` | Keep the more recent or more specific note (Rule 7); tombstone or delete the other |
| `TOPIC-SINGLETON` | Judge: merge into an established topic (retag + cross-link) if it's a synonym/fragment; keep if genuinely emerging — then add a same-topic link when a second note arrives |
| `TAG-SPRAWL` | A tag (topic or ad hoc) is used by exactly one note; same judgment as `TOPIC-SINGLETON` — merge into an established tag or accept as genuinely new |
| `NO-INBOUND` | Note has outbound links but nothing links back to it; add a `[[wikilink]]` from a related note, or fold it into MEMORY.md |
| `EXPIRED` | `metadata.expires` is past due; re-verify the claim, refresh `updated`/`expires`, or prune per the freshness schema in `memory-write` |
| `STALE-ORPHAN` | Over 180 days old AND no inbound links — the two-factor dead-weight signal (age alone is not sufficient reason to act); verify against current state or prune with the link-survival rule |
| `NAME-MISMATCH` | `name:` frontmatter disagrees with the filename; decide which is authoritative and fix the other |
| `TYPE-MISMATCH` | `metadata.type` disagrees with the `type/*` tag; retag both to whichever type actually fits (see Fix Categorization) |
| `BROKEN-LINK-NAME` | Gate-blocking, like `BROKEN-LINK`: a `[[wikilink]]` target matches no note's declared `name:` field even though a same-named file exists — usually caused by a `NAME-MISMATCH`; fix the mismatch or re-point the link |

### 4. Fix Categorization

The linter only checks that `type/*` and `topic/*` tags are *present* — it cannot judge whether they're *correct*. For every note flagged during triage, or otherwise touched during this review, verify categorization by reading the note:

- **Type:** confirm `metadata.type`, the `type/*` tag, and the note's actual content all agree. If a note tagged `type/research` is really recording feedback (or vice versa), retag it — update the `type/*` tag and `metadata.type` together, and adjust `description` if it no longer matches the corrected type.
- **Topic:** confirm the `topic/*` tag actually describes the content. If it's a synonym or near-duplicate of an established topic (e.g. `topic/state-mgmt` vs an existing `topic/state-management`), retag to the established topic rather than letting the taxonomy fragment — topics are emergent, so there's no fixed list to validate against, only consistency with what's already in use (see `TOPIC-SINGLETON` above).
- After any retag, update `metadata.updated` to today.

### 5. Verify Against Repo State

For each note flagged as stale or any note whose claim seems load-bearing, verify it reflects current reality: use the `Grep` tool with pattern `<keyword>` and path `.claude/` to check whether the described file/pattern still exists, and cross-check recent history:

```bash
git log --oneline -10
```

If the memory is accurate: update `metadata.updated` to today.
If it's outdated: update the body OR prune with the link-survival rule below.

**Clearing a dirty flag:** When a note's claims are verified (or updated) and its outbound links are confirmed accurate, remove both the `dirty` and `dirty_reason` keys from the `metadata` block and remove the banner line from the top of the body. Both edits reverse in the same pass — the closing `---` itself is never touched:

Before:

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

After:

```yaml
---
name: some-note
metadata:
  type: project
  updated: 2026-07-26
---

Existing body text, now re-verified.
```

Update `metadata.updated` to today. Never clear without verifying. Never leave the banner line inside the `metadata:` block — that is invalid YAML, not a partially-cleared flag.

### 6. Reconcile Contradictions

If two notes make conflicting claims about the same topic (Rule 7 — surface conflicts, don't average):
1. Determine which is more recent or more battle-tested (check `metadata.updated`, git log).
2. Keep the authoritative note; update it to acknowledge the resolved conflict.
3. Tombstone the superseded note.

### 7. Connect Orphans

Before pruning an orphan, check if it is genuinely valueless or just disconnected:
- If valuable: add a `[[wikilink]]` from a related note, or add it to the folder's MEMORY.md.
- If not valuable: prune with the link-survival rule.

### 8. Prune with Link Survival

**Never hard-delete a note that has inbound `[[wikilinks]]` without doing one of these first:**

**Option A — Re-point:** edit each linking note to target a successor instead.

**Option B — Tombstone stub:** replace the pruned note's body with:

```yaml
---
name: <original-slug>
description: Tombstone — superseded by <successor-slug>.
tags:
  - type/tombstone
  - topic/<x>
  - agent/<a>
metadata:
  type: tombstone
  updated: <YYYY-MM-DD>
---

Superseded by [[successor-slug]]. Removed because: <reason>.
```

To find inbound links before pruning: use the `Grep` tool with pattern `\[\[<slug>\]\]` and path `.claude/agent-memory/`.

### 9. Update MEMORY.md

After any note is added, renamed, or removed: update the folder's `MEMORY.md` to reflect the current state. The linter's `FILE-NOT-INDEXED` check will catch any missed entries on the next run.

### 10. Promote Durable Memories (workbench only)

Some memories outgrow the vault: a note that encodes durable, *generalizable* behavior — a user directive that applies in every project, a recurring operating tactic, an engineering lesson — belongs in an agent definition, skill, or rule, where it is loaded deterministically instead of recalled probabilistically. Project-specific facts, decaying research, and recurring-judgment heuristics (review bars, implementation gotchas) stay in the vault — that is what agent memory is for.

For each note touched during review, ask: *would every future session in every project need this?* If yes, it is a promotion candidate.

**Workbench guard — promotion may only edit files in the canonical workbench repo.** Workbench identity is marker-based, not path-based: a repo is the canonical workbench when its root contains **both** `.claude-plugin/marketplace.json` **and** `scripts/sync-global.ps1`. This works identically across machines and OSes because no path is ever hardcoded — check for the two files' presence, not a specific filesystem location. Agent, skill, and operating-rule content elsewhere are consumer-installed plugin copies (obtained via `/plugin marketplace add` + `/plugin install`, not deployed by any script); editing them forks the canonical source and would require reverse-centralization. In any other project, do NOT edit instruction files — instead write a file to the machine-global queue `~/.claude/agent-memory/promotion-queue/<slug>.md` containing: the proposed instruction text, the target file (e.g. `plugins/conductor/agents/implement.md`), the source project (repo name/path), the date, and provenance (the note-slug that prompted the promotion). The workbench drains this queue automatically in step 1 on its next review — no need to surface it to the user separately.

After promoting in the workbench:
1. Annotate the source note: add a line `**Promoted to `<target-file>` on <YYYY-MM-DD>**` and slim any body text now duplicated by the instruction — the note keeps the *why*/provenance, the instruction carries the behavior. Never leave the full text in both places (drift risk).
2. Note for the human: there is no build or sync step for agents/skills — the change is live in the next session in this workbench (the repo dogfoods its own plugin via `.claude/settings.json`), and reaches other machines once the commit is published and consumers run `/plugin marketplace update`.

### 11. Final Lint

Run the linter once more to confirm the vault is clean:

```bash
pwsh scripts/memory-lint.ps1
```

Expected output: `OK  Vault is clean.` with exit code 0.

**Do not trigger the memory subagent after this pass.** Propagation would dirty-flag the very notes this review just verified, converting a clean vault back into noise for the next reviewer. If specific notes were left genuinely unverified, flag those individually in the summary rather than propagating wholesale.

## Output Format

Return a change summary:

```
## Memory Review Summary

**Promotion queue drained (workbench only):** <N> accepted, <N> rejected — <one-line reason per rejection, or "N/A — not in workbench" / "queue empty">
**Linter run:** <N> errors, <N> warnings before review
**After fixes:** <exit code and clean/dirty status>

**Changes made:**
- Updated: <file> — <reason>
- Pruned (tombstone): <file> — <reason>; inbound re-pointed to [[<successor>]]
- Connected: added [[<link>]] in <file> to resolve orphan
- Reconciled: kept <file-A> over <file-B> (Rule 7); <file-B> tombstoned

**Vault status:** Clean / <N> items deferred for human judgment
**Propagation:** Suppressed — see step 11 (the memory subagent not triggered after a review pass)
**Deferred:** <any items needing human input and why>
```

## Constraints

- Never delete a file with inbound `[[wikilinks]]` without first tombstoning or re-pointing.
- Never overwrite a note's body based solely on the linter output — verify against repo state first.
- When uncertain whether a memory is stale, update `metadata.updated` and add a note in the body rather than pruning.
- Do not prune a note merely because it is old; prune when it is inaccurate or superseded.
- Never promote a memory into agent/skill/rule files outside the canonical workbench repo — write a promotion-queue file (`~/.claude/agent-memory/promotion-queue/<slug>.md`) instead, for the workbench to drain on its next review (step 1).
- Never invoke the memory subagent at the end of a `memory-review` pass — state the suppression and reason explicitly in the summary (see step 11).
