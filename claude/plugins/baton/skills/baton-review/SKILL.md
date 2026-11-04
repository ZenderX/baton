---
name: baton-review
description: Migrate a project's older conductor or refuter memory (type-prefixed notes, Obsidian vault, worker folders, dirty/superseded lifecycle, native wikilinks) to the okf-memory OKF v0.2 bundle, losing no fact, migrate every legacy .claude/ job artefact (job folders, archives merged per entry, jobs/local, environment files, pre-v5 leftovers, .gitignore lines) to .baton/ after a confirmed pre-move report so only .claude/agent-memory/ remains, and distil raw archived job folders into the OKF job bundle.
disable-model-invocation: true
---

# Baton Review

Convert every older conductor or refuter memory folder in this project to the OKF v0.2 bundle, with no fact lost, move legacy job data from `.claude/` to `.baton/` (step 2), and distil every raw archived job folder into its product's job bundle (step 5, **Job archives**). Optional argument: one memory folder or job archive path; restrict the run to it.

## 1. Load the target

Read `../okf-memory/SKILL.md` (the `okf-memory` skill, beside this skill's folder) and follow it as the only target format. These rules say how to get there; where they seem to differ, `okf-memory` wins.

## 2. Move job data to `.baton/`

Run from the repo root, before discovery; every later step reads job data under `.baton/` only. Afterwards nothing baton-owned is left under `.claude/` except memory. Memory stays in `.claude/agent-memory/` and `.claude/agent-memory-local/`, the paths Claude Code reads: this step never moves, edits or deletes anything there, nor `.claude/` itself. Move with plain `mv`, never `git mv`, and never stage: the user reviews the move as tracked files deleted at the old path and untracked at the new one.

Sources and targets, for each `<o>` of `conductor`, `refuter`:
- Job folder `.claude/<o>/jobs/<job-id>/` (every folder there besides `archive/` and `local/`, active or stale) → `.baton/<o>/jobs/<job-id>/` as-is; skip one whose target exists. Closing a stale job is job-lifecycle **Archive on request**, never this step.
- Archive `.claude/<o>/jobs/archive/` (OKF notes with `index.md`, or v5.0.x raw folders), merged per entry into `.baton/<o>/jobs/archive/`: each note `<name>.md` or raw folder `<name>/` moves under its name, together with `.claude/<o>/jobs/local/<name>/` → `.baton/<o>/jobs/local/<name>/`. A taken name gets job-lifecycle's suffix `-2`, `-3`, …, the same on the note, raw folder and local folder; taken: `archive/<name>.md`, `archive/<name>/` or `local/<name>/` exists in the target (or, for a suffixed name, in the source), or `git log --all --format=%h -1 -- .baton/<o>/jobs/archive/<name>.md` prints anything.
- `.claude/<o>/jobs/local/<name>/` with no note: moves the same way.
- `.claude/<o>/jobs/archive/references/<file>` → `.baton/<o>/jobs/archive/references/<file>`, suffixed `-2`, `-3`, … before the extension when taken.
- `.claude/<o>/jobs/archive/index.md` → `.baton/<o>/jobs/archive/index.md` when that is absent, else merged line by line (fix-up below).
- Environment, in priority order `.claude/environment.md`, `.claude/conductor/environment.md`, `.claude/refuter/environment.md`: the first that exists → `.baton/environment.md` when that is absent; every other one → `.baton/environment.legacy.md` (`environment.legacy-2.md`, … when taken), and the user merges it into `.baton/environment.md` by hand.
- Transient pre-v5 leftovers, deleted (no `.baton/` equivalent): `.claude/<o>/job/`, `.claude/task-plan.md`, `.claude/conductor/task-plan.md`, `.claude/refuter/task-plan.md`, `.claude/conductor/plan.md`.
- Any other entry in `.claude/<o>/`, `.claude/<o>/jobs/`, `jobs/archive/` or `jobs/local/`, dotfiles and dot-folders included (a pre-v4 layout is unmapped): report it as `LEAVE`, never guess a target.
- With an argument, act only on a source the argument names, lies inside, or contains: set `a` to it as a repo-relative path; without one, leave `a` empty.

```sh
a=''; a=${a#./}; a=${a%/}; run=''
in_a() { [ -z "$a" ] && return 0; case "$1/" in "$a"/*) return 0;; esac; case "$a/" in "$1"/*) return 0;; esac; return 1; }
mv1() { if [ -e "$2" ]; then echo "SKIP $1: $2 exists"; return; fi; echo "MOVE $1 -> $2"; if [ -n "$run" ]; then mkdir -p "${2%/*}" && mv "$1" "$2" || echo "FAIL $1"; fi; }
rm1() { echo "DELETE $1"; if [ -n "$run" ]; then rm -rf -- "$1" || echo "FAIL $1"; fi; }
taken() { for r in "$T" "$L"; do [ "$r" = "$L" ] && [ "$1" = "$b" ] && continue; { [ -e "$r/archive/$1.md" ] || [ -e "$r/archive/$1" ] || [ -e "$r/local/$1" ]; } && return 0; done; [ -n "$(git log --all --format=%h -1 -- "$T/archive/$1.md")" ]; }
for o in conductor refuter; do
  L=.claude/$o/jobs; T=.baton/$o/jobs
  for e in .claude/$o/* .claude/$o/.[!.]*; do [ -e "$e" ] || continue; case ${e##*/}:$o in jobs:*|job:*|environment.md:*|task-plan.md:*|plan.md:conductor) ;; *) echo "LEAVE $e";; esac; done
  for e in "$L"/* "$L"/.[!.]*; do [ -e "$e" ] || continue; case ${e##*/} in archive|local) ;; *) if [ -d "$e" ]; then in_a "$e" && mv1 "$e" "$T/${e##*/}"; else echo "LEAVE $e"; fi;; esac; done
  names=$(for e in "$L"/archive/* "$L"/archive/.[!.]* "$L"/local/* "$L"/local/.[!.]*; do [ -e "$e" ] || continue; b=${e##*/}; case $e in "$L"/archive/index.md|"$L"/archive/references) ;; "$L"/archive/*.md) echo "${b%.md}";; *) if [ -d "$e" ]; then echo "$b"; else echo "LEAVE $e" >&2; fi;; esac; done | sort -u)
  for b in $names; do
    for p in "$L/archive/$b.md" "$L/archive/$b" "$L/local/$b"; do [ -e "$p" ] && in_a "$p" && break; p=''; done; [ -n "$p" ] || continue
    n=$b; i=1; while taken "$n"; do i=$((i+1)); n=$b-$i; done
    [ "$n" = "$b" ] || echo "RENAME $o $b -> $n"
    [ -e "$L/archive/$b.md" ] && mv1 "$L/archive/$b.md" "$T/archive/$n.md"
    [ -e "$L/archive/$b" ] && mv1 "$L/archive/$b" "$T/archive/$n"
    [ -e "$L/local/$b" ] && mv1 "$L/local/$b" "$T/local/$n"
  done
  for e in "$L"/archive/references/* "$L"/archive/references/.[!.]*; do
    [ -e "$e" ] && in_a "$e" || continue
    f=${e##*/}; s=${f%.*}; x=${f#"$s"}; n=$s; i=1
    while [ -e "$T/archive/references/$n$x" ] || { [ "$n" != "$s" ] && [ -e "$L/archive/references/$n$x" ]; }; do i=$((i+1)); n=$s-$i; done
    [ "$n" = "$s" ] || echo "RENAME $o references/$f -> $n$x"
    mv1 "$e" "$T/archive/references/$n$x"
  done
  e=$L/archive/index.md
  if [ -e "$e" ] && in_a "$e"; then if [ -e "$T/archive/index.md" ]; then echo "MERGE $e -> $T/archive/index.md"; else mv1 "$e" "$T/archive/index.md"; fi; fi
done
w=''; k=1
for s in .claude/environment.md .claude/conductor/environment.md .claude/refuter/environment.md; do
  [ -e "$s" ] || continue
  if [ -z "$w" ] && [ ! -e .baton/environment.md ]; then w=$s; in_a "$s" && mv1 "$s" .baton/environment.md; continue; fi
  in_a "$s" || continue
  n=.baton/environment.legacy.md; [ "$k" -gt 1 ] && n=.baton/environment.legacy-$k.md
  while [ -e "$n" ]; do k=$((k+1)); n=.baton/environment.legacy-$k.md; done; k=$((k+1))
  mv1 "$s" "$n"; echo "MERGE-BY-HAND $n -> .baton/environment.md"
done
for s in .claude/conductor/job .claude/refuter/job .claude/task-plan.md .claude/conductor/task-plan.md .claude/refuter/task-plan.md .claude/conductor/plan.md; do [ -e "$s" ] && in_a "$s" && rm1 "$s"; done
```

1. **Report.** Run the block with `run=''`; it changes nothing. Draft the `.gitignore` rewrite (below) without writing it. Present the pre-move report: every `MOVE` source → target, each `RENAME` suffix, `MERGE`, `MERGE-BY-HAND`, `DELETE`, `SKIP` and `LEAVE` line, and the `.gitignore` diff. For moved job folders, say that a job still running in another session must stop before the user confirms, and that a stale one is closed afterwards by asking its orchestrator to archive it (job-lifecycle **Archive on request**). End the turn asking for confirmation; move nothing until the user says yes. An empty report (no line, no `.gitignore` change) needs no confirmation: go to `## 3. Discover`.
2. **Move.** On yes, run the block again with `run=1`. Its lines must match the confirmed report; on a difference or a `FAIL` line, stop and report it.
3. **Fix up**, with file edits, never a shell rewrite:
   - Each `MERGE`: take every line under the legacy `index.md`'s `# Jobs`, its link set to the note's final name; insert each one whose link the target `index.md` lacks under the target's `# Jobs`, in job-lifecycle's `* [<title>](<name>.md) - <description>` form, at its date position, newest first. Lines under `## References` go under the target's `## References` the same way, the heading added last when absent. Then delete the legacy `index.md`.
   - Each `RENAME <o> <name> -> <new>` of a note: in `.baton/<o>/jobs/archive/<new>.md`, set `sources` `resource: ../local/<name>/` to `../local/<new>/`, and make the target `index.md` line link `(<new>.md)`. A renamed raw folder is distilled under its new name (step 5).
   - Each `RENAME <o> references/<file> -> <new>`: point its `## References` line at `references/<new>`.
   - `.gitignore`: write the confirmed rewrite.
4. **Clean up.** Remove the emptied legacy folders; a `KEPT` folder still holds a `SKIP` or `LEAVE` entry:

```sh
for o in conductor refuter; do for d in .claude/$o/jobs/archive/references .claude/$o/jobs/archive .claude/$o/jobs/local .claude/$o/jobs .claude/$o; do [ -d "$d" ] || continue; rmdir "$d" 2>/dev/null || echo "KEPT $d: not empty"; done; done
```

`.gitignore` rewrite, without an argument only (a restricted run leaves it and the report says so), in the repo-root `.gitignore`. A line's path is its pattern after an optional `!` and leading `/`, both kept in the rewrite; the first matching rule applies:
- Path `.claude/<o>/job` or starting `.claude/<o>/job/`, or path `.claude/task-plan.md`, `.claude/conductor/task-plan.md`, `.claude/refuter/task-plan.md` or `.claude/conductor/plan.md`: remove the line; a deleted pre-v5 path is never rewritten to `.baton/`.
- Path `.claude/environment.md` or `.claude/<o>/environment.md`: `.baton/environment.md`.
- Path `.claude/<o>` or starting `.claude/<o>/`: the same with `.baton/<o>` (`!.claude/conductor/jobs/archive/` → `!.baton/conductor/jobs/archive/`).
- A rewritten line already in the file: remove it rather than add a duplicate. Keep every other line and the line order; keep the file's line endings; never add a line the project did not have. A glob that may match a baton path (`.claude/*/jobs/`): report it, leave it.

A second run finds no source to move and prints only `SKIP`, `LEAVE` and `KEPT` lines, if any.

## 3. Discover

Glob only these paths; never search the whole repo or drive.
- `.claude/agent-memory/*/`, `.claude/agent-memory-local/*/`, and nested strays `.claude/agent-memory/*/.claude/agent-memory/*/`.
- Vault leftovers in `.claude/agent-memory/`: `_conventions.md`, `.obsidian/`, `topics/`.
- `~/.claude/agent-memory/promotion-queue/` and job-side `.baton/{conductor,refuter}/jobs/*/memory.md`: report only.
- Job bundles `.baton/{conductor,refuter}/jobs/archive/` only, never a legacy `.claude/` path (step 2 moved them): their notes, `index.md`, `references/`, and any raw job folder directly under `archive/`. Never read `.baton/{conductor,refuter}/jobs/local/`.

Classify each folder:
- **Target:** `baton-conductor/`, `baton-refuter/`. Create `baton-conductor/` when only older conductor folders exist, `baton-refuter/` when only older refuter folders exist.
- **Stray of `baton-conductor/`:** `conductor-main/`, `conductor/`, `conductor-core-*/`, `conductor-<role>/` (`implement`, `planning`, `research`, `code-review`, `memory`), `*-subagent/` (`planning`, `implement`, `research`, `code-review`, `memory`), and nested strays.
- **Stray of `baton-refuter/`:** `refuter-main/` and any other `refuter-<role>/`.
- **Local:** `.claude/agent-memory-local/<x>/` is private; convert it in place as its own target, never merge it into a tracked folder.
- **Other:** another agent's memory; report it and leave it, unless the user named it, then convert it in place as its own target.

Run `git status --short -- <folder>` per folder. Git cannot restore a folder it does not track; ask the user before editing one. Report the folders found and their era (step 4) before changing anything.

## 4. Detect the era

Grep frontmatter keys, links and the index; do not bulk-read notes. A folder may mix eras: apply every matching row in step 5.

| Marker | Era |
|---|---|
| `<type>_<slug>.md` filenames, `name`/`description`/`metadata.type` with no top-level `type` or `title`, index `# Conductor Memory Index` | E1 type-prefixed |
| `tags:` with `type/*`, `topic/*`, `agent/*`; `metadata.updated`; `.obsidian/`, `topics/`, `_conventions.md`; unscoped folder names | E2 Obsidian vault |
| folder `conductor-core-*` or `conductor-<role>`; `freshness`, `expires`, `supersedes` | E3 plugin-scoped workers |
| `conductor-main/` with the vault schema and `agent/main`; dirty flags; index `title: <agent> · index` or `## <Group>` headings | E4 single vault |
| E4 schema in `refuter-main/` or beside it; `## Related` `[[slug]]` lists; `SUPERSEDED` hooks | E5 per-product vaults |
| `name`/`description`/`metadata.type` with no top-level `type` or `title`, no tags; index `- [[slug]] — hook` | E6 native-only |
| top-level `type` and `title`; `MEMORY.md` has `okf_version` | OKF already: add a missing `name`, `metadata.type` or `MEMORY.md` `description`, else verify only |

## 5. Convert

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
| index `title:` frontmatter, `# <Agent> Memory Index`, intro line, `## <Group>` headings, hook suffixes | discard; step 7 rebuilds |
| promotion-queue files | report; never apply |
| pending job `memory.md` sections | report as candidate facts; never ingest silently |
| `[memory]` result lines, `memory.result.md`, linter codes | no note content; leave them |
| raw job folder directly under `jobs/archive/` | distil it to a job note (**Job archives**), add its index line, then `mv` the folder to `jobs/local/<name>/` |
| job note without an `index.md` line | add the line at its date position, newest first |
| `skills/*.md` copies in a raw job folder | never retained in the bundle; they move with the raw folder |

**Stray folders** (the v4 `memory-review` skill's consolidation, minus dirty flags)
- Move every note into its target. Same-slug collision: the target's note wins; merge any new fact from the stray copy into it, then delete the copy. Unrelated notes sharing a slug: rename the stray one.
- Merge the stray index entries, each pointing at the note's final filename.
- Report non-note files and leave them, except the artefacts deleted above.
- Remove the emptied folder; never leave one half-migrated.
- Never move a note between products; on a cross-product slug clash, rename only the note being converted.

**Merge and prune** (the v4 `memory-review` skill's rules that `okf-memory` allows)
- Duplicates: merge into one survivor, the more recent or more specific, and re-point inbound links.
- Contradictions: keep the more recent or better-tested fact, edit it in place, delete the other.
- Prune only an inaccurate or superseded note, never one merely old. Unsure: keep it and flag it.
- An insight that belongs in an agent, skill or rule file: report it, never write it there.
- One fact per note; flat folder; no tombstones, memory agent or linter.

**Job archives**

The job bundle `.baton/<product>/jobs/archive/` (`product`: `conductor`, `refuter`) is its own OKF v0.2 bundle, separate from the memory vault; the `okf-memory` note types and `MEMORY.md` rules do not apply to it.
- Flat notes `<YYYY-MM-DD>-<slug>.md`, one per ended job; `<YYYY-MM-DD>-<slug>` is the raw folder's name.
- One root `index.md` whose only frontmatter is `okf_version: "0.2"`, then a `# Jobs` heading and one `* [Title](<YYYY-MM-DD>-<slug>.md) - <description>` line per note, newest first, title and description copied from the note; retained artifacts are listed under a final `## References` heading as `* [Title](references/<file>.md) - <description>`.
- Optional `references/` folder for the few retained artifacts; each `.md` file in it carries frontmatter with `type: reference`, `title` and `description`.
- Raw job folders live untracked at `.baton/<product>/jobs/local/<YYYY-MM-DD>-<slug>/`, and in git history before the commit that removed them from `archive/`.

Job note schema: frontmatter keys
- `type: job`
- `title: <slug words in sentence case>`
- `description: <one sentence: what the job changed or decided>`
- `job_id: <YYYYMMDD-hhmm-xxxx>` (omit when unknown)
- `archived: <YYYY-MM-DD>` (producer key, date only)
- `outcome: complete | incomplete | unknown` (never `status`, which OKF §5.4 reserves for lifecycle)
- `tags: [job, <product>]`
- `sources:` one entry `- resource: ../local/<YYYY-MM-DD>-<slug>/` with `title: raw job folder (untracked, on the machine that ran the job)`

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

## 6. Preserve facts

- Keep a ledger: each source note → kept, renamed to, merged into, or deleted, with the reason.
- Before deleting or merging a note, confirm each of its facts lands in a surviving note (or, for a promoted note, the named file).
- Never drop a fact silently.

## 7. Rebuild `MEMORY.md`

Per `okf-memory`: its frontmatter (exactly `type: index`, `title`, `description` and `okf_version: "0.2"`; no `name` or `metadata`, since `MEMORY.md` is not a note), one `## <Type>` group per type in use, one entry per note with title and description copied from the note. At 200 lines or more, merge duplicate notes until under; report it.

## 8. Verify

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
J=.baton/conductor/jobs/archive
for f in $J/*.md $J/references/*.md; do [ -e "$f" ] || continue; case "$f" in */index.md) continue;; esac; head -1 "$f" | grep -q '^---' && grep -q '^type: .' "$f" || echo "FAIL $f"; done
for f in $J/*.md; do b=$(basename "$f"); [ "$b" = index.md ] || grep -qF "]($b)" $J/index.md || echo "INDEX $b"; done
find $J -mindepth 1 -type d ! -path "$J/references"
```

Checks: every note and reference has frontmatter with `type`; every note has an `index.md` line; the bundle is flat except `references/` (a listed folder is a raw job folder still to distil).

## 9. Report

- Step 2: each move to `.baton/`, archive and `index.md` merge, suffix rename, deletion, skipped target, `LEAVE` entry and `KEPT` folder, each `environment.legacy*.md` to merge by hand, the `.gitignore` diff, and moved job folders with the pointer to job-lifecycle **Archive on request** for stale ones.
- Per folder: path, era, notes before → after, the folder's fate (converted, merged into `<target>`, removed).
- Per job bundle: raw folders distilled to notes and moved to `jobs/local/`, index lines added, artifacts retained under `references/`.
- Every delete, merge and rename from the ledger, with the reason.
- Unverified facts that carried dirty flags, items reported only (promotion queue, job `memory.md` sections, agent-file insights, non-note files, other agents' folders), and any rule conflict and how it was resolved.
- Do not commit; the user reviews the diff.
