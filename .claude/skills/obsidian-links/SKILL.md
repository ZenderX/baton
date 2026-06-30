---
name: obsidian-links
description: How to wikilink memory notes — syntax forms, when to link, finding inbound links, avoiding orphans, re-pointing when re-linking dirty notes. Pairs with memory-write.
---

# Obsidian Links

Connect memory notes with `[[wikilinks]]` so the graph is navigable and the linter's orphan/broken-link checks pass. Wikilinks are how agents discover related context and how the linter validates graph health.

## Syntax

```
[[slug]]              # link by note slug (bare filename without .md)
[[slug|display text]] # link with custom display text
```

The target is always the **note's basename** (filename without `.md`) — not a path, not a heading. Casing is ignored by the linter (it compares lowercased), but prefer lowercase slugs for consistency.

Examples:
```
See [[auth-flow-ordering]] for the sequencing constraints.
This was caused by the issue described in [[db-pooling|OOM incident]].
```

## When to Link

Link liberally — over-linking is better than under-linking:

- When writing a note, link to any related notes you know exist.
- When updating a note, scan its topic and add links to notes on the same topic.
- When adding a note that a future note will probably reference, use `[[future-slug]]` as a placeholder — dangling links are acceptable TODO markers, not errors.

**Avoid orphans.** A memory note with no inbound and no outbound links will trigger the linter's `ORPHAN` check. Every note you write should have at least one link in or out before the task is done.

## Finding Inbound Links

To find all notes that link to a given slug:

```bash
grep -r "\[\[slug\]\]" .claude/agent-memory/
```

Use this before pruning or renaming a note, and before clearing a dirty flag (to know which neighbors need re-linking).

## Re-pointing Links (dirty-note re-linking)

When you clear a dirty flag after updating a note's content, re-check outbound links:

1. Read the updated note and confirm all its `[[links]]` still point to current, accurate notes.
2. If a linked note has been renamed or tombstoned, update the link to point to the successor.
3. If the updated note's content now implies a new relationship, add a new `[[link]]`.

This keeps the graph accurate after the memory-subagent's propagation pass.

## Tombstone Re-pointing

Before removing a note that has inbound links:

1. Find all inbound links: `grep -r "\[\[slug\]\]" .claude/agent-memory/`
2. For each linking note, either:
   - **Re-point:** replace `[[old-slug]]` with `[[successor-slug]]`, or
   - **Leave as tombstone pointer:** the pruned note becomes a tombstone stub that redirects to `[[successor]]`.

Never hard-delete a note with inbound links without doing one of these first — broken links become `BROKEN-LINK` integrity errors that gate the linter.

## Constraints

- Target must be a note basename — not a file path, not a heading anchor.
- Dangling links (`[[not-yet-written]]`) are acceptable but should be created soon.
- Broken links (target not found anywhere in the vault) are gate-blocking linter errors — resolve before finishing.
- Do not wikilink to MEMORY.md files — they are folder indexes accessed by path, not link targets.
