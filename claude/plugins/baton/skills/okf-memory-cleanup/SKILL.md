---
name: okf-memory-cleanup
description: Migrate a project's older conductor or refuter memory (type-prefixed notes, Obsidian vault, worker folders, dirty/superseded lifecycle, native wikilinks) to the okf-memory OKF v0.2 bundle, losing no fact, and distil raw archived job folders into the OKF job bundle.
disable-model-invocation: true
---

# OKF Memory Cleanup

Convert every older conductor or refuter memory folder in this project to the OKF v0.2 bundle, with no fact lost, and distil every raw archived job folder into its product's job bundle (step 4, **Job archives**). Optional argument: one memory folder or job archive path; restrict the run to it.

## 1. Load the target

Read `../okf-memory/SKILL.md` (the `okf-memory` skill, beside this skill's folder) and follow it as the only target format. These rules say how to get there; where they seem to differ, `okf-memory` wins.

## 2. Discover

Glob only these paths; never search the whole repo or drive.
- `.claude/agent-memory/*/`, `.claude/agent-memory-local/*/`, and nested strays `.claude/agent-memory/*/.claude/agent-memory/*/`.
- Vault leftovers in `.claude/agent-memory/`: `_conventions.md`, `.obsidian/`, `topics/`.
- `~/.claude/agent-memory/promotion-queue/` and job-side `.claude/{conductor,refuter}/jobs/*/memory.md`: report only.
- Job bundles `.claude/{conductor,refuter}/jobs/archive/`: their notes, `index.md`, `references/`, and any raw job folder directly under `archive/`. Never read `.claude/{conductor,refuter}/jobs/local/`.

Classify each folder:
- **Target:** `baton-conductor/`, `baton-refuter/`. Create `baton-conductor/` when only older conductor folders exist, `baton-refuter/` when only older refuter folders exist.
- **Stray of `baton-conductor/`:** `conductor-main/`, `conductor/`, `conductor-core-*/`, `conductor-<role>/` (`implement`, `planning`, `research`, `code-review`, `memory`), `*-subagent/` (`planning`, `implement`, `research`, `code-review`, `memory`), and nested strays.
- **Stray of `baton-refuter/`:** `refuter-main/` and any other `refuter-<role>/`.
- **Local:** `.claude/agent-memory-local/<x>/` is private; convert it in place as its own target, never merge it into a tracked folder.
- **Other:** another agent's memory; report it and leave it, unless the user named it, then convert it in place as its own target.

Run `git status --short -- <folder>` per folder. Git cannot restore a folder it does not track; ask the user before editing one. Report the folders found and their era (step 3) before changing anything.

## 3. Detect the era

Grep frontmatter keys, links and the index; do not bulk-read notes. A folder may mix eras: apply every matching row in step 4.

| Marker | Era |
|---|---|
| `<type>_<slug>.md` filenames, `name`/`description`/`metadata.type` with no top-level `type` or `title`, index `# Conductor Memory Index` | E1 type-prefixed |
| `tags:` with `type/*`, `topic/*`, `agent/*`; `metadata.updated`; `.obsidian/`, `topics/`, `_conventions.md`; unscoped folder names | E2 Obsidian vault |
| folder `conductor-core-*` or `conductor-<role>`; `freshness`, `expires`, `supersedes` | E3 plugin-scoped workers |
| `conductor-main/` with the vault schema and `agent/main`; dirty flags; index `title: <agent> · index` or `## <Group>` headings | E4 single vault |
| E4 schema in `refuter-main/` or beside it; `## Related` `[[slug]]` lists; `SUPERSEDED` hooks | E5 per-product vaults |
| `name`/`description`/`metadata.type` with no top-level `type` or `title`, no tags; index `- [[slug]] — hook` | E6 native-only |
| top-level `type` and `title`; `MEMORY.md` has `okf_version` | OKF already: add a missing `name`, `metadata.type` or `MEMORY.md` `description`, else verify only |

## 4. Convert

Order: lifecycle artefacts, then stray folders, then frontmatter, then links (after every rename and move), then the index; job archives are independent of the memory steps.

**Frontmatter and files**

| Artefact | OKF action |
|---|---|
| `<type>_<slug>.md` | rename to `<slug>.md` |
| `metadata.type` | top-level `type` and `metadata.type`, both set to the same value: `user`, `feedback`, `project`, `reference` stay; `implementation`, `planning`, `review`, `gotcha` → `project`; `research` → `reference`; `hub`, `tombstone`: see Lifecycle |
| missing `metadata.type` | add a trailing `metadata:` block holding `  type:` equal to top-level `type` |
| `name` | equals the file slug, the filename without `.md`: set it after any rename, add it when missing |
| missing `title` | the old index entry's link text; else from the description or slug |
| `description` | keep; over ~150 chars → one sentence, rest moves to the body |
| `modified`, other unknown keys | keep |
| key order | `name`, `type`, `title`, `description`, then optional and unknown keys, then the `metadata:` block last |
| frontmatter value containing `: ` or ` #`, or starting with a YAML special character | quote it in double quotes; unquoted, ` #` starts a YAML comment and truncates the value |
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
| raw job folder directly under `jobs/archive/` | distil it to a job note (**Job archives**), add its index line, then `mv` the folder to `jobs/local/<name>/` |
| job note without an `index.md` line | add the line at its date position, newest first |
| `skills/*.md` copies in a raw job folder | never retained in the bundle; they move with the raw folder |

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

**Job archives**

The job bundle `.claude/<product>/jobs/archive/` (`product`: `conductor`, `refuter`) is its own OKF v0.2 bundle, separate from the memory vault; the `okf-memory` note types and `MEMORY.md` rules do not apply to it.
- Flat notes `<YYYY-MM-DD>-<slug>.md`, one per ended job; `<YYYY-MM-DD>-<slug>` is the raw folder's name.
- One root `index.md` whose only frontmatter is `okf_version: "0.2"`, then a `# Jobs` heading and one `* [Title](<YYYY-MM-DD>-<slug>.md) - <description>` line per note, newest first, title and description copied from the note; retained artifacts are listed under a final `## References` heading as `* [Title](references/<file>.md) - <description>`.
- Optional `references/` folder for the few retained artifacts; each `.md` file in it carries frontmatter with `type: reference`, `title` and `description`.
- Raw job folders live untracked at `.claude/<product>/jobs/local/<YYYY-MM-DD>-<slug>/`, and in git history before the commit that removed them from `archive/`.

Job note schema: frontmatter keys
- `type: job`
- `title: <slug words in sentence case>`
- `description: <one sentence: what the job changed or decided>`
- `job_id: <YYYYMMDD-hhmm-xxxx>` (omit when unknown)
- `archived: <YYYY-MM-DD>` (producer key, date only)
- `outcome: complete | incomplete | unknown` (never `status`, which OKF §5.4 reserves for lifecycle)
- `tags: [job, <product>]`
- `sources:` one entry `- resource: ../local/<YYYY-MM-DD>-<slug>/` with `title: raw job folder (untracked; in git history before the migration commit)`

Body sections in order:
- `## Goal` (from `request.md` **Goal**)
- `## Outcome` (review verdict and completion state, from `review.md` `## job` or the last result file)
- `## Decisions` (from `plan.md` `## job` **Rationale** and each phase's `**Decisions:**`)
- `## Phases` (table: phase id, goal, verdict)
- `## Memory` (memory notes the job wrote or updated, if `memory.result.md` or `review.md` names them)
- `## Artifacts` (files retained under `references/`, else `None.`)

Distil procedure, per raw folder:
- Read only `request.md`, `plan.md` `## job`, `review.md`, and the `**Decisions:**` lines of result files; never copy result files wholesale.
- A folder with no review or result files: `outcome: unknown`, goal from `request.md`.
- 20 to 60 lines per note; quote a frontmatter value that contains `: ` or ` #`, or starts with a YAML special character, in double quotes.
- Write the note, add its index line, then `mv` the folder to `jobs/local/<YYYY-MM-DD>-<slug>/`. Never retain `skills/*.md` copies or build-time baselines; a retained artifact goes to `references/` with frontmatter prepended and its body unchanged.

## 5. Preserve facts

- Keep a ledger: each source note → kept, renamed to, merged into, or deleted, with the reason.
- Before deleting or merging a note, confirm each of its facts lands in a surviving note (or, for a promoted note, the named file).
- Never drop a fact silently.

## 6. Rebuild `MEMORY.md`

Per `okf-memory`: its frontmatter (exactly `type: index`, `title`, `description` and `okf_version: "0.2"`; no `name` or `metadata`, since `MEMORY.md` is not a note), one `## <Type>` group per type in use, one entry per note with title and description copied from the note. At 200 lines or more, merge duplicate notes until under; report it.

## 7. Verify

Run from the repo root once per converted folder, setting `M`; never `cd`. Each check prints nothing on success.

```sh
M=.claude/agent-memory/baton-conductor
for f in $M/*.md; do head -1 "$f" | grep -q '^---' && sed -n '2,/^---/p' "$f" | tr -d '\r' | grep -Eq '^type: *(feedback|project|reference|user|index)$' || echo "TYPE $f"; done
for f in $M/*.md; do LC_ALL=C.UTF-8 sed 's/`[^`]*`//g' "$f" | grep -qE '\[\[|\]\(/' && echo "LINK $f"; done
grep -oh '](\./[^)]*)' $M/*.md | sed 's/^](\.\///; s/)$//; s/#.*//' | sort -u | while read -r p; do [ -f "$M/$p" ] || echo "BROKEN $p"; done
for f in $M/*.md; do b=$(basename "$f"); [ "$b" = MEMORY.md ] || [ "$(grep -cF "(./$b)" $M/MEMORY.md)" = 1 ] || echo "INDEX $b"; done
[ "$(LC_ALL=C.UTF-8 grep -cE '^\* \[[^]]+\]\(\./[^)]+\.md\) - .+' $M/MEMORY.md)" = "$(ls $M/*.md | grep -vc '/MEMORY\.md$')" ] || echo "ENTRY-COUNT"
for f in $M/*.md; do [ "$(basename "$f")" = MEMORY.md ] && continue; d=$(LC_ALL=C.UTF-8 sed -n 's/^description: *//p' "$f" | head -1 | tr -d '\r' | sed 's/^"\(.*\)"$/\1/'); LC_ALL=C.UTF-8 grep -qF -- "$d" $M/MEMORY.md || echo "DESC $f"; done
[ "$(wc -l < $M/MEMORY.md)" -lt 200 ] || echo "SIZE"
for f in $M/*.md; do b=$(basename "$f" .md); [ "$b" = MEMORY ] || sed -n '2,/^---/p' "$f" | tr -d '\r' | grep -Eqx "name: *$b" || echo "NAME $f"; done
for f in $M/*.md; do [ "$(basename "$f")" = MEMORY.md ] && continue; fm=$(sed -n '2,/^---/p' "$f" | tr -d '\r'); t=$(printf '%s\n' "$fm" | sed -n 's/^type: *//p'); m=$(printf '%s\n' "$fm" | sed -n '/^metadata:/,/^[^ ]/s/^  type: *//p'); [ -n "$t" ] && [ "$m" = "$t" ] || echo "META $f"; done
for f in $M/*.md; do sed -n '2,/^---/p' "$f" | tr -d '\r' | LC_ALL=C.UTF-8 grep -qE "^ *(- )?[A-Za-z_]+: [^\"'].* #" && echo "HASH $f"; done
LC_ALL=C.UTF-8 grep -nE '^ *(dirty|dirty_reason|supersedes|freshness|expires|updated):|^ *type: *(tombstone|hub)|^ *- (type|agent)/|\*\*(DIRTY|SUPERSEDED)' $M/*.md
find $M -mindepth 1 -type d
```

Checks: frontmatter `type`; no `[[` or root-absolute links outside code spans; links resolve; one index entry per note, in OKF form; descriptions match; index under 200 lines; `name` equals the file slug (`NAME`); `metadata.type` equals top-level `type` (`META`); no unquoted frontmatter value containing ` #` (`HASH`); no lifecycle leftovers or subfolders. Fix and re-run until all are silent.

Then once per job bundle that exists, setting `J`:

```sh
J=.claude/conductor/jobs/archive
for f in $J/*.md $J/references/*.md; do [ -e "$f" ] || continue; case "$f" in */index.md) continue;; esac; head -1 "$f" | grep -q '^---' && grep -q '^type: .' "$f" || echo "FAIL $f"; done
for f in $J/*.md; do b=$(basename "$f"); [ "$b" = index.md ] || grep -qF "]($b)" $J/index.md || echo "INDEX $b"; done
find $J -mindepth 1 -type d ! -path "$J/references"
```

Checks: every note and reference has frontmatter with `type`; every note has an `index.md` line; the bundle is flat except `references/` (a listed folder is a raw job folder still to distil).

## 8. Report

- Per folder: path, era, notes before → after, the folder's fate (converted, merged into `<target>`, removed).
- Per job bundle: raw folders distilled to notes and moved to `jobs/local/`, index lines added, artifacts retained under `references/`.
- Every delete, merge and rename from the ledger, with the reason.
- Unverified facts that carried dirty flags, items reported only (promotion queue, job `memory.md` sections, agent-file insights, non-note files, other agents' folders), and any rule conflict and how it was resolved.
- Do not commit; the user reviews the diff.
