---
name: memory-review
description: Audit the .claude/agent-memory/ vault for accuracy, staleness, and graph integrity. Runs the deterministic linter first, then applies judgment to verify, reconcile, and prune. Safe: no blind deletion.
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

### 1. Run the Linter

```bash
pwsh scripts/memory-lint.ps1
```

Capture the full output. Any integrity errors (broken links, dead index entries) must be resolved before judgment work.

If integrity errors exist, run:
```bash
pwsh scripts/memory-lint.ps1 -Fix
```

Then re-run in report mode and confirm exit 0 before proceeding.

### 2. Triage the Linter Report

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

### 3. Verify Against Repo State

For each note flagged as stale or any note whose claim seems load-bearing, verify it reflects current reality:

```bash
# Check if the described file/pattern still exists
grep -r "<keyword>" .claude/
git log --oneline -10
```

If the memory is accurate: update `metadata.updated` to today.
If it's outdated: update the body OR prune with the link-survival rule below.

**Clearing a dirty flag:** When a note's claims are verified (or updated) and its outbound links are confirmed accurate, remove both the `dirty` and `dirty_reason` keys from the `metadata` block and remove the banner line from the top of the body:

```
> ⚠️ **DIRTY (since <YYYY-MM-DD>):** may be stale — re-evaluate against current state and re-link before relying on this. Reason: <reason>.
```

Update `metadata.updated` to today. Never clear without verifying.

### 4. Reconcile Contradictions

If two notes make conflicting claims about the same topic (Rule 7 — surface conflicts, don't average):
1. Determine which is more recent or more battle-tested (check `metadata.updated`, git log).
2. Keep the authoritative note; update it to acknowledge the resolved conflict.
3. Tombstone the superseded note.

### 5. Connect Orphans

Before pruning an orphan, check if it is genuinely valueless or just disconnected:
- If valuable: add a `[[wikilink]]` from a related note, or add it to the folder's MEMORY.md.
- If not valuable: prune with the link-survival rule.

### 6. Prune with Link Survival

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

To find inbound links before pruning:
```bash
grep -r "\[\[<slug>\]\]" .claude/agent-memory/
```

### 7. Update MEMORY.md

After any note is added, renamed, or removed: update the folder's `MEMORY.md` to reflect the current state. The linter's `FILE-NOT-INDEXED` check will catch any missed entries on the next run.

### 8. Final Lint

Run the linter once more to confirm the vault is clean:

```bash
pwsh scripts/memory-lint.ps1
```

Expected output: `OK  Vault is clean.` with exit code 0.

## Output Format

Return a change summary:

```
## Memory Review Summary

**Linter run:** <N> errors, <N> warnings before review
**After fixes:** <exit code and clean/dirty status>

**Changes made:**
- Updated: <file> — <reason>
- Pruned (tombstone): <file> — <reason>; inbound re-pointed to [[<successor>]]
- Connected: added [[<link>]] in <file> to resolve orphan
- Reconciled: kept <file-A> over <file-B> (Rule 7); <file-B> tombstoned

**Vault status:** Clean / <N> items deferred for human judgment
**Deferred:** <any items needing human input and why>
```

## Constraints

- Never delete a file with inbound `[[wikilinks]]` without first tombstoning or re-pointing.
- Never overwrite a note's body based solely on the linter output — verify against repo state first.
- When uncertain whether a memory is stale, update `metadata.updated` and add a note in the body rather than pruning.
- Do not prune a note merely because it is old; prune when it is inaccurate or superseded.
