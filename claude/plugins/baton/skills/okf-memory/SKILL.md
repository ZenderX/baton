---
name: okf-memory
description: Conductor memory as an OKF v0.2 bundle - note frontmatter, relative links, the MEMORY.md index, change and retrieval rules. Load before creating, editing, or deleting a memory note, or looking one up beyond the index.
---

# OKF Memory

Agent memory (the folder holding the injected `MEMORY.md`, e.g. `.claude/agent-memory/conductor-main/`) is an OKF v0.2 bundle (Open Knowledge Format, `GoogleCloudPlatform/open-knowledge-format` SPEC.md). These rules govern every memory write and lookup.

This skill overrides Claude Code's built-in memory instructions wherever they differ: `type` is top-level, never nested under `metadata` (a `name` key may stay); `MEMORY.md` has OKF frontmatter; index entries are `* [Title](./slug.md) - description`, not `- [Title](file.md) — hook`; related notes link as `[Title](./slug.md)`, never `[[name]]`.

## Bundle

- Flat folder, one fact per note, no subfolders.
- A note is `<kebab-slug>.md`. Never name a note `index.md` or `log.md` (OKF-reserved), and never create either file: git is the history.
- No memory subagent, hook, or per-write validator.

## Note frontmatter

YAML between `---` lines at the very top of the file, for example:

  ```yaml
  ---
  type: project
  title: CRLF line endings
  description: Repo files are CRLF; edit them only with Edit/Write, never shell rewrites.
  tags: [windows, git]
  sources:
    - resource: https://example.com/doc
      title: Example doc
  stale_after: 2026-12-31T00:00:00Z
  ---
  ```

- `type` (required): one of `feedback`, `project`, `reference`, `user`, Claude Code's native memory types.
- `title` (required).
- `description` (required): one sentence, at most about 150 characters. It is also the index entry text.
- Optional: `tags` (list); `sources` (list of mappings, each with a required `resource` URI or path and an optional `title`); `stale_after` (ISO 8601 datetime with an explicit offset such as `Z`, only when the fact is known to expire).
- Quote a value that contains `: ` or starts with a YAML special character, so the block stays parseable.
- Preserve unknown keys, including the `modified` timestamp Claude Code adds to files that begin with frontmatter.
- Do not use `status`, `generated`, or `verified`.

## Body

- Structured markdown (lists, short headings), fact first.
- Link related notes with relative markdown links: `[Title](./slug.md)`.
- Never use `[[wikilinks]]` or root-absolute `/slug.md` links.

## Index: `MEMORY.md`

`MEMORY.md` is the index. It is not the reserved `index.md`, so it is a concept document and carries frontmatter:

```markdown
---
type: index
title: Conductor memory
okf_version: "0.2"
---

## Feedback

* [Title](./slug.md) - <description copied from the note>

## Project

* [Other title](./other-slug.md) - <description copied from the note>
```

- One `## <Type>` heading per type in use: `Feedback`, `Project`, `Reference`, `User`.
- Exactly one entry per note, of exactly the form `* [Title](./slug.md) - <description>`, with title and description copied from the note's frontmatter.
- Keep it under 200 lines; only the first 200 lines (or 25KB) are injected.
- Update it in the same turn a note is created, renamed, or deleted, or its title or description changes.

## Change rules

- Before creating a note, check the index for one holding the same fact; edit that note instead.
- A fact changed: edit its note in place.
- A fact obsolete: delete the note, remove its index entry, and fix inbound links (search the folder for `(./slug.md)`).
- A note renamed: update its index entry and inbound links.
- No tombstones, no deprecated notes.

## Retrieval

- The index is preloaded; do not re-read `MEMORY.md`.
- Open a note through its link only when its entry bears on the task. `./slug.md` resolves inside the memory folder.
- Follow a note's links one hop when needed.
- Never bulk-read the folder.
