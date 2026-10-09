---
name: okf-memory-migrate
description: Migrate a project's older conductor or refuter memory (type-prefixed notes, Obsidian vault, worker folders, dirty/superseded lifecycle, native wikilinks) to the okf-memory OKF v0.2 bundle, losing no fact.
disable-model-invocation: true
---

# OKF Memory Migrate

Convert every older conductor or refuter memory folder in this project to the OKF v0.2 bundle, with no fact lost. Optional argument: one memory folder path; restrict the run to it.

## 1. Load the target

Read `../okf-memory/SKILL.md` (the `okf-memory` skill, beside this skill's folder) and follow it as the only target format. These rules say how to get there; where they seem to differ, `okf-memory` wins.

## 2. Discover

Glob only these paths; never search the whole repo or drive.
- `.claude/agent-memory/*/`, `.claude/agent-memory-local/*/`, and nested strays `.claude/agent-memory/*/.claude/agent-memory/*/`.
- Vault leftovers in `.claude/agent-memory/`: `_conventions.md`, `.obsidian/`, `topics/`.
- `~/.claude/agent-memory/promotion-queue/` and job-side `.claude/{conductor,refuter}/jobs/*/memory.md`: report only.

Classify each folder:
- **Target:** `conductor-main/`, `refuter-main/`. Create `conductor-main/` when only older conductor folders exist.
- **Stray of `conductor-main/`:** `conductor/`, `conductor-core-*/`, `conductor-<role>/` (`implement`, `planning`, `research`, `code-review`, `memory`), `*-subagent/` (`planning`, `implement`, `research`, `code-review`, `memory`), and nested strays.
- **Stray of `refuter-main/`:** any other `refuter-<role>/`.
- **Local:** `.claude/agent-memory-local/<x>/` is private; convert it in place as its own target, never merge it into a tracked folder.
- **Other:** another agent's memory; report it and leave it, unless the user named it, then convert it in place as its own target.

Run `git status --short -- <folder>` per folder. Git cannot restore a folder it does not track; ask the user before editing one. Report the folders found and their era (step 3) before changing anything.

## 3. Detect the era

Grep frontmatter keys, links and the index; do not bulk-read notes. A folder may mix eras: apply every matching row in step 4.

| Marker | Era |
|---|---|
| `<type>_<slug>.md` filenames, only `name`/`description`/`metadata.type`, index `# Conductor Memory Index` | E1 type-prefixed |
| `tags:` with `type/*`, `topic/*`, `agent/*`; `metadata.updated`; `.obsidian/`, `topics/`, `_conventions.md`; unscoped folder names | E2 Obsidian vault |
| folder `conductor-core-*` or `conductor-<role>`; `freshness`, `expires`, `supersedes` | E3 plugin-scoped workers |
| `conductor-main/` with the vault schema and `agent/main`; dirty flags; index `title: <agent> · index` or `## <Group>` headings | E4 single vault |
| E4 schema in `refuter-main/` or beside it; `## Related` `[[slug]]` lists; `SUPERSEDED` hooks | E5 per-product vaults |
| `name`/`description`/`metadata.type`, no tags; index `- [[slug]] — hook` | E6 native-only |
| top-level `type` and `title`; `MEMORY.md` has `okf_version` | OKF already: verify only |

## 4. Convert

Order: lifecycle artefacts, then stray folders, then frontmatter, then links (after every rename and move), then the index.

**Frontmatter and files**

| Artefact | OKF action |
|---|---|
| `<type>_<slug>.md` | rename to `<slug>.md` |
| `metadata.type` | top-level `type`: `user`, `feedback`, `project`, `reference` stay; `implementation`, `planning`, `review`, `gotcha` → `project`; `research` → `reference`; `hub`, `tombstone`: see Lifecycle |
| missing `title` | the old index entry's link text; else from the description or slug |
| `description` | keep; over ~150 chars → one sentence, rest moves to the body |
| `name`, `modified`, other unknown keys | keep; drop the `metadata:` block once empty |
| `tags` | drop `type/*`, `agent/*` and `decaying`; `topic/<x>` → `tags: [<x>]` |
| `metadata.updated`, `freshness`, `aliases`, `decaying` | drop; a `decaying` note may get `stale_after` = `updated` + 90 days |
| `metadata.expires: <date>` | `stale_after: <date>T00:00:00Z` |
| `dirty`, `dirty_reason`, `> ⚠️ **DIRTY ...` banner | check the fact against the repo and correct it; then remove both keys and the banner. Unverifiable: keep the fact, list it in the report |
| `> ℹ️ **Context (<date>):**` banner | fold into the body as a plain fact |
| `**Promoted to <file> on <date>**` line, `PROMOTED` hook | the named file still holds the rule → delete the note; else drop the line, keep the fact |

**Links**

| Artefact | OKF action |
|---|---|
| `[[slug]]`, `Related: [[slug]]`, `See [[slug]]`, `## Related` lists | `[Title](./slug.md)` with the target's final slug and title |
| `[[slug\|alias]]`, `[[slug#h]]` | `[alias](./slug.md)`, `[Title](./slug.md#h)` |
| `[[x]]` with no note in the folder (forward link, other product, deleted) | plain text `x` |
| root-absolute `](/slug.md)` | `](./slug.md)` |

**Lifecycle**

| Artefact | OKF action |
|---|---|
| tombstone (`type: tombstone`, tag `type/tombstone`) | re-point inbound links to its successor, then delete it |
| superseded note (`SUPERSEDED` description, hook or banner; successor's `supersedes:`) | move the banner's live correction and any fact the successor lacks into the successor; re-point inbound links; delete the old note; drop `supersedes` |
| deprecated note or `status` key | successor exists: as superseded; else edit to the current fact and drop the key |
| topic hub (`type: hub`, `topics/`) | delete; it holds only links |
| `_conventions.md`, `.obsidian/`, `*.tmp` | delete |
| index `title:` frontmatter, `# <Agent> Memory Index`, intro line, `## <Group>` headings, hook suffixes | discard; step 6 rebuilds |
| promotion-queue files | report; never apply |
| pending job `memory.md` sections | report as candidate facts; never ingest silently |
| `[memory]` result lines, `memory.result.md`, linter codes | no note content; leave them |

**Stray folders** (the old `/memory-review` consolidation, minus dirty flags)
- Move every note into its target. Same-slug collision: the target's note wins; merge any new fact from the stray copy into it, then delete the copy. Unrelated notes sharing a slug: rename the stray one.
- Merge the stray index entries, each pointing at the note's final filename.
- Report non-note files and leave them, except the artefacts deleted above.
- Remove the emptied folder; never leave one half-migrated.
- Never move a note between products; on a cross-product slug clash, rename only the note being converted.

**Merge and prune** (old `/memory-review` rules that `okf-memory` allows)
- Duplicates: merge into one survivor, the more recent or more specific, and re-point inbound links.
- Contradictions: keep the more recent or better-tested fact, edit it in place, delete the other.
- Prune only an inaccurate or superseded note, never one merely old. Unsure: keep it and flag it.
- An insight that belongs in an agent, skill or rule file: report it, never write it there.
- One fact per note; flat folder; no tombstones, memory agent or linter.

## 5. Preserve facts

- Keep a ledger: each source note → kept, renamed to, merged into, or deleted, with the reason.
- Before deleting or merging a note, confirm each of its facts lands in a surviving note (or, for a promoted note, the named file).
- Never drop a fact silently.

## 6. Rebuild `MEMORY.md`

Per `okf-memory`: its frontmatter, one `## <Type>` group per type in use, one entry per note with title and description copied from the note. At 200 lines or more, merge duplicate notes until under; report it.

## 7. Verify

Run from the repo root once per converted folder, setting `M`; never `cd`. Each check prints nothing on success.

```sh
M=.claude/agent-memory/conductor-main
for f in $M/*.md; do head -1 "$f" | grep -q '^---' && sed -n '2,/^---/p' "$f" | tr -d '\r' | grep -Eq '^type: *(feedback|project|reference|user|index)$' || echo "TYPE $f"; done
for f in $M/*.md; do LC_ALL=C.UTF-8 sed 's/`[^`]*`//g' "$f" | grep -qE '\[\[|\]\(/' && echo "LINK $f"; done
grep -oh '](\./[^)]*)' $M/*.md | sed 's/^](\.\///; s/)$//; s/#.*//' | sort -u | while read -r p; do [ -f "$M/$p" ] || echo "BROKEN $p"; done
for f in $M/*.md; do b=$(basename "$f"); [ "$b" = MEMORY.md ] || [ "$(grep -cF "(./$b)" $M/MEMORY.md)" = 1 ] || echo "INDEX $b"; done
[ "$(LC_ALL=C.UTF-8 grep -cE '^\* \[[^]]+\]\(\./[^)]+\.md\) - .+' $M/MEMORY.md)" = "$(ls $M/*.md | grep -vc '/MEMORY\.md$')" ] || echo "ENTRY-COUNT"
for f in $M/*.md; do [ "$(basename "$f")" = MEMORY.md ] && continue; d=$(LC_ALL=C.UTF-8 sed -n 's/^description: *//p' "$f" | head -1 | tr -d '\r' | sed 's/^"\(.*\)"$/\1/'); LC_ALL=C.UTF-8 grep -qF -- "$d" $M/MEMORY.md || echo "DESC $f"; done
[ "$(wc -l < $M/MEMORY.md)" -lt 200 ] || echo "SIZE"
LC_ALL=C.UTF-8 grep -nE '^ *(dirty|dirty_reason|supersedes|freshness|expires|updated):|^ *type: *(tombstone|hub)|^ *- (type|agent)/|\*\*(DIRTY|SUPERSEDED)' $M/*.md
find $M -mindepth 1 -type d
```

Checks: frontmatter `type`; no `[[` or root-absolute links outside code spans; links resolve; one index entry per note, in OKF form; descriptions match; index under 200 lines; no lifecycle leftovers or subfolders. Fix and re-run until all are silent.

## 8. Report

- Per folder: path, era, notes before → after, the folder's fate (converted, merged into `<target>`, removed).
- Every delete, merge and rename from the ledger, with the reason.
- Unverified facts that carried dirty flags, items reported only (promotion queue, job `memory.md` sections, agent-file insights, non-note files, other agents' folders), and any rule conflict and how it was resolved.
- Do not commit; the user reviews the diff.
