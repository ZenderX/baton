# Job-file contract

This document is the authoring spec for the transactional job-file protocol used by the conductor and refuter products on the Claude and pi harnesses.

Every non-main agent is a transaction: it reads one input file, does the work, writes one result file, and replies with one line. Main is the only agent that talks to the human. On pi, the orchestrator (`pi/conductor/orchestrator.md`, `pi/refuter/orchestrator.md`) plays the role of main.

Both products dispatch the same five workers, shipped by the `team` plugin: `team:scout`, `team:architect`, `team:developer`, `team:tester`, and `team:expert` on Claude (`claude/plugins/team/agents/`), the bare names `scout`, `architect`, `developer`, `tester`, and `expert` on pi (`pi/team/agents/`). The conductor dispatches all but `expert`; the refuter dispatches all five.

Workers take their input from files because subagents do not get `TaskGet` or `TaskUpdate` (Claude Code 2.1.283). The task list remains main's own status board and is never a worker's input.

## Agents cannot read this document

Installed plugins cannot read the repository's `docs/` folder at runtime. Each agent prompt therefore carries its own part of this contract: its row of the role table, the schema of the file it reads, the schema of the file it writes, the dispatch grammar, and the reply grammar. When this document changes, every agent prompt that embeds the changed part changes with it.

## Locations

| Product | Job root | Replaces |
|---|---|---|
| conductor | `.claude/conductor/jobs/` | worker dossiers held in task descriptions |
| refuter | `.claude/refuter/jobs/` | the refuter's former single plan file |

Each active job has its folder `.claude/<product>/jobs/<job-id>/`. The refuter folder mirrors the conductor shape so that one set of schemas and one set of worker prompts serves both products. In the refuter, the job folder's `plan.md` replaces the refuter's former single plan file, which is no longer written.

Both products share one environment file, `.claude/environment.md`, which is user-owned and lives outside every `jobs/` folder. Whichever orchestrator runs first generates it once when it is absent; thereafter it is user truth. Workers read it on demand for OS, editor, and toolchain facts and never write it. The job lifecycle never edits or deletes it.

`jobs/` is ignored by git through the repository's root `.gitignore`.

### Folder layout

```text
.claude/<product>/jobs/<job-id>/
  request.md               # main: preamble and the human's goal, written at job start
  plan.md                  # architect: one anchored section per phase
  scout.md                 # architect, or refuter main: scout questions, one anchored section each
  scout.result.md          # scout: a job section at orient, one section per question
  <phase-id>.result.md     # developer: one file per phase
  review.md                # tester: one block per phase with its verdict
  issues.md                # tester: one block per failing phase, the fixes a fix pass must make
  opinion.md               # refuter expert: per-claim risk
  skills/<name>.md         # main: copied SKILL.md text for workers
  scripts/<script>         # pi only: pi orchestrator's copies of the scripts workers run
.claude/<product>/jobs/archive/<YYYY-MM-DD>-<slug>/   # ended or closed jobs
```

A file appears only when its role runs. `<phase-id>` is a lowercase kebab-case slug that is unique within the job, for example `p1-job-file-contract`.

## Lifecycle

1. **Job start.** Main generates `<job-id>` as `YYYYMMDD-HHMM-<4 lowercase hex>`, independent of any session id, runs `mkdir -p .claude/<product>/jobs`, then a plain `mkdir` of the job folder, which fails if it exists; main then picks new hex, so sessions never share a folder. Main writes `request.md` and copies the needed skills into `skills/` (see Skill delivery); on pi, the refuter orchestrator also copies worker scripts into `scripts/` (see Script delivery).
2. **Work.** Main dispatches workers one line at a time. Each worker reads its input file, writes its output file, and replies.
3. **Job end.** After the final gate, main deletes every task it created and moves the job folder to `.claude/<product>/jobs/archive/<YYYY-MM-DD>-<slug>/`: the archive day, then a lowercase kebab-case summary of the initial prompt, five words at most, suffixed `-2`, `-3`, ... on collision.

**Ownership.** A session never touches a job folder it did not create.

**Resume on request.** Only when the human asks, main lists active folders (`jobs/*/` except `archive/`) with job id and `## job` **Goal**, adopts the one picked, reads `plan.md` and the existing result files and continues from the first phase without a `COMPLETE` result. A result file that still opens with `**Status:** in progress` is salvage, not `COMPLETE`. Main creates tasks for the remaining phases in its own list.

**Archive on request.** For a job left aside, main appends `**Closed incomplete:** <YYYY-MM-DD>` to its `request.md` preamble and moves its folder into `jobs/archive/` under the job-end naming rule.

**Memory.** Main alone writes memory: after reading the job's result files, it saves durable, non-obvious facts as notes in its own memory vault. Workers write none.

**Archived jobs.** No agent walks `jobs/archive/`; main opens an archived file only when a memory note names it.

**Task lists** are per session on both harnesses. Claude uses its default, with no project-wide `CLAUDE_CODE_TASK_LIST_ID`; pi's engine task store is keyed by the pi session id. Resuming the same session keeps its list; Claude `/clear` and pi `/new` or `/fork` start a new one.

## Anchors

Each section that a dispatch can address is a level-2 heading whose text is its anchor, written exactly as the slug: `## p1-job-file-contract`. The anchor in a dispatch matches that heading text verbatim. A file with a single subject uses the anchor `job`.

## Dispatch grammar

Main, or the spawning worker named in the role table, sends exactly one line:

```text
<Verb> <file>#<anchor>.
```

`<file>` is the project-relative path of a file in the job folder, e.g. `Plan .claude/conductor/jobs/20260101-0900-a3f9/request.md#job.` That file's directory is the worker's job folder: every path it reads or writes (section, sibling results, skills, scripts) and every scout dispatch it sends resolves there, in the same full-path form. The worker reads that section of that file, plus any file the section names.

| Verb | Role | Example |
|---|---|---|
| `Scout` | scout, orient | `Scout .claude/<product>/jobs/<job-id>/request.md#job.` |
| `Scout` | scout, one question | `Scout .claude/<product>/jobs/<job-id>/scout.md#q1-plugin-cache-path.` |
| `Plan` | architect | `Plan .claude/<product>/jobs/<job-id>/request.md#job.` |
| `Implement` | developer | `Implement .claude/<product>/jobs/<job-id>/plan.md#p1-job-file-contract.` |
| `Fix` | developer | `Fix .claude/<product>/jobs/<job-id>/issues.md#p1-job-file-contract.` |
| `Review` | tester, whole job (conductor) | `Review .claude/conductor/jobs/<job-id>/plan.md#job.` |
| `Review` | tester, one phase (refuter) | `Review .claude/refuter/jobs/<job-id>/plan.md#p1-job-file-contract.` |
| `Consult` | expert (refuter only) | `Consult .claude/refuter/jobs/<job-id>/review.md#p1-job-file-contract.` |

## Reply grammar

A worker's final message is exactly one line, one of:

```text
COMPLETE
BLOCKED: <reason>
```

`<reason>` is one sentence that names what is missing or contradictory. A worker that replies `BLOCKED: <reason>` still writes its output file with whatever it established. Any other reply text is a protocol violation, and main treats it as `BLOCKED`.

On pi, the engine kills a worker that issues the same tool call three times in a row, and replies for it `BLOCKED: <guard> — <reason>` followed by its last tool calls. No agent on either harness sets a turn cap. On pi, a drift nudge running inside each child steers a worker that repeats searches or results, or (for `developer`) goes 40 calls without a Surface edit, with a `[drift]` message to take a concrete next step or write its result as `BLOCKED` with Gaps; it never kills.

**Rolling output.** Every worker keeps its output current while it works, so a stopped worker leaves its established findings on disk. It creates its output file early, or adds its own section to a shared file (`scout.result.md`, the single-phase tester's `review.md`, `opinion.md`, each written under the rule in its schema below), and its first line is the marker:

```text
**Status:** in progress
```

After each confirmed finding or completed step, the worker updates the file with what is established and its next intended step, at milestones rather than after every tool call. Until the final write, a verdict-bearing file holds findings only: `review.md` has no `**Verdict:**` line, `plan.md` has no phase table or phase section to dispatch from, and `opinion.md` has no claim table. `issues.md` is written only in the final write, together with the verdicts, never while the marker stands. The final write replaces the file or section whole in its normal schema, without the marker.

**Salvage.** A `COMPLETE` reply whose output file or section still opens with the marker counts as `BLOCKED`. On `BLOCKED`, a guard kill or stopped worker, or a missing or garbled reply, main reads the output file if it exists and copies a marked file's established facts into the worker's input section as needing no re-reading, the one edit allowed to a section after its dispatch apart from appended `plan.md#job` **Revision** lines; with no file, it uses the guard's trace. It then corrects or narrows the section and spawns the worker fresh, never reading a marked file as a result, verdict, or plan. The refuter phase cycle's own handling wins: after expert `BLOCKED` main rules on the tester alone, and after tester `BLOCKED` it surfaces a marked `review.md` section as partial findings. The architect, the one dispatching worker, applies the same rule to its `scout.result.md` sections, copying the facts into a new `scout.md` question section.

`plan.md` has no Gaps section; a worker writing it that has something to flag replies `BLOCKED: <reason>` instead.

## Role table

The "Spawned by" column names the only agent that dispatches the role.

| Product | Harness | Role | Input file | Output file | Spawned by |
|---|---|---|---|---|---|
| conductor, refuter | Claude, pi | scout | orient: `request.md#job`; question: `scout.md#<question-id>` | `scout.result.md#job` or `scout.result.md#<question-id>` | orient: main; question: architect, or refuter main |
| conductor, refuter | Claude, pi | architect | `request.md#job` plus `scout.result.md#job` when present | `plan.md` | main |
| conductor, refuter | Claude, pi | developer | `plan.md#<phase-id>`; fix pass: `issues.md#<phase-id>` | `<phase-id>.result.md` | main |
| conductor | Claude, pi | tester, whole job | `plan.md#job` plus every `<phase-id>.result.md` | `review.md`, plus `issues.md` when any phase fails | main |
| refuter | Claude, pi | tester, one phase | `plan.md#<phase-id>` plus `<phase-id>.result.md` | `review.md#<phase-id>`, plus `issues.md#<phase-id>` when the phase fails | main |
| refuter | Claude, pi | expert | `review.md#<phase-id>` (its disputed claims) | `opinion.md#<phase-id>` | main |

The architect spawns its question scouts itself, not through main: it writes `scout.md`, seeds `scout.result.md` with `# Scout results` when the file is absent, spawns one scout per question, and reads their sections before it writes `plan.md`.

The tester holds `Write` and `Edit`: in whole-job mode it overwrites `review.md` and, when a phase fails, `issues.md` whole; in single-phase mode it changes only its own phase's block in each.

## Review cycle

A fix pass is a fresh spawn that reads `issues.md`. No worker is resumed.

**Conductor.** Once every phase has a `COMPLETE` result, main applies the review-tier escalation, deletes any previous `issues.md`, and runs the effective **Review tier** (see plan.md). At `none`, main's mechanical all-green check passing leads to the final gate; otherwise the review tier rises to `light`. At `light` or `full`, main dispatches `Review plan.md#job.` to the tester in whole-job mode; a `light` review whose `review.md` preamble carries `**Escalate: full** — <reason>` makes main append a `full` **Revision** line and dispatch Review again before acting on any verdict. Verdicts are binding: main reads each `**Verdict:**` line literally, counts a missing or malformed one as `FAIL`, and never overrides, downgrades, or skips a `FAIL`. Every verdict `PASS` leads to the final gate. On a `FAIL` in a phase block, main dispatches `Fix issues.md#<phase-id>.` for each failing phase, a fresh developer that overwrites `<phase-id>.result.md`, then deletes `issues.md` and dispatches Review again. A `FAIL` in the `job` block, a diff-wide finding no phase owns, gets no `Fix`: failing phases are fixed and re-reviewed first, and a `job` `FAIL` still standing after that goes to the human with its findings, and the job closes incomplete. Fix rounds have no cap: the loop repeats until every verdict is `PASS`, and the tester's findings win over the developer's claims. Only a `BLOCKED` review goes to the human with the findings from `review.md`.

**Refuter.** Each phase runs `Implement`, then `Review plan.md#<phase-id>.` (the tester in single-phase mode), then `Consult` when `review.md#<phase-id>` lists disputed claims. Main rules on the verdict with the opinion, and on a remaining `FAIL` dispatches `Fix issues.md#<phase-id>.` to a fresh developer, followed by a fresh tester. Fix passes have no cap: the cycle repeats until main accepts the phase.

## Schemas

Every schema below is a literal template. Placeholders are in angle brackets. A section with nothing to report contains the single line `None.`

### request.md

No worker reads the preamble above `## job`; its initial prompt names the archive.

```markdown
# Request

**Job id:** <job-id>

**Initial prompt:** <the human's initial prompt, verbatim>

## job

**Goal:** <the human's goal in one or two sentences>

**Constraints:** <limits the human stated, or None.>

**Diff base:** <branch or commit that review diffs against>
```

### plan.md

`plan.md` starts with a `job` index section, then one anchored section per phase. Each phase section is self-contained, because a worker reads only its own section. The architect writes the same schema for both products. The job-level **Acceptance criteria**, **Verification commands**, and **Review tier** are read by the conductor and the whole-job tester; the refuter's gate runs per phase and does not use them.

**Rationale** applies to both products: whoever writes `plan.md` (the architect, or refuter main on its Direct tier, where it writes the plan itself) records there, in two to four sentences, the decisions its planning reached: the refuter workflow tier chosen (refuter main only), why that review tier, the key decomposition or ordering decision, and the alternatives rejected with why. **Revision** lines are optional and main's alone: on each global re-plan or conductor review-tier escalation main appends one dated line to the end of the `job` section, never editing or deleting earlier **Rationale** or **Revision** text, so the original reasoning survives a resume.

**Review tier** is read by the conductor and the whole-job tester: `none`, `light`, or `full`, with a one-clause reason, set by the architect from the "When" column below; the conductor never re-judges it, and **Rationale** names why. An absent field means `full`.

| Review tier | When | What runs |
|---|---|---|
| `none` | Docs, prompts, config, copy, or mechanical single-surface edits where every acceptance item is checkable by one command | No review dispatch: main runs a mechanical all-green check from the repo root — every **Verification commands** entry exits 0, every file in `git diff --name-only <Diff base>` lies inside some phase's **Surface**, and every result file's Gaps is `None.` — and never judges code; anything else raises the review tier to `light` |
| `light` | Moderate code changes inside one surface, no public interface changed | the tester on changed hunks and one-hop callers, plus the **Verification commands** and every acceptance criterion; on Claude it is dispatched with `model: "sonnet"`, while pi's `subagent` takes no per-call model, so there `light` saves cost through narrower scope only |
| `full` | Public API, schema, migration, security, or concurrency changes, parallel phases sharing an interface, and every user-requested review (a review-only job, "review this branch"), whatever the field says | the tester reads every touched file whole and traces every caller |

The architect picks the lowest review tier whose "When" fits every phase; any phase meeting a `full` trigger makes the job `full`. **Escalation:** only mechanical triggers apply. Once every phase is `COMPLETE`, a result file with non-empty Gaps or an unconfirmed claim, a file in `git diff --name-only <Diff base>` outside every phase's **Surface**, or a failing verification command raises the review tier one step; the tester's `**Escalate: full**` line raises it to `full`. Main adds no judgment-based trigger of its own. **Review tier** stays as planned: main records each escalation as an appended `**Revision:** <YYYY-MM-DD> — review tier <light|full>: <trigger>` line, and the effective review tier is the latest such line, else **Review tier**. A fix round re-reviews at the effective review tier and never lowers it.

```markdown
# Plan

## job

**Goal:** <the job goal>

**Rationale:** <why that review tier, the key decomposition or ordering decision, and the alternatives rejected with why>

**Review tier:** <none | light | full> — <one-clause reason>

**Diff base:** <branch or commit>

**Acceptance criteria:**
- <job-level checkable criterion, 2 to 5 items>

**Verification commands:**
- `<build, typecheck, lint, or test command>`

| Phase | Depends on |
|---|---|
| <phase-id> | <phase-id list, or none> |

**Revision:** <YYYY-MM-DD> — <what changed in the plan and why>

**Revision:** <YYYY-MM-DD> — review tier <light|full>: <trigger>

## <phase-id>

**Goal:** <one sentence: what is true when this phase is done>

**Surface:** <module, directory, or feature area this phase owns>

**Context:** <requirements and facts the worker needs; no file:line references>

**Out of scope:** <paths and areas the worker must not change>

**Unknowns:** <open questions the worker must resolve or report, or None.>

**Acceptance criteria:**
- <checkable criterion, ideally a command and its expected output>

**Conventions:** <names of the skills that apply, e.g. rust, typescript, or None.>

**Skills:**
- `.claude/<product>/jobs/<job-id>/skills/<name>.md`

**Research:** <dated facts from the scout, each with its source, or None.>
```

### `<phase-id>.result.md`

The developer writes this file. A fix pass overwrites it with the full current state, not a delta.

```markdown
# <phase-id> result

## Changed files
- `<path>`: <one line: what changed and why>

## Interfaces
- `<symbol or file>`: <added | changed>, <shape later phases depend on>

## Verification
| Command | Result |
|---|---|
| `<command>` | <pass or fail, with the output line that proves it> |

## Gaps
- <unmet criterion, plan error, unconfirmed claim, or assumption made; or None.>
```

### review.md

The tester writes it in one of two modes. Whole-job (conductor): it is the only writer and overwrites the file whole, one block per phase plus a `job` block in the same shape for diff-wide checks, and, only at `light` when the diff meets a `full` trigger, one `**Escalate: full** — <reason>` line in the preamble. Single-phase (refuter): experts of other phases may read the file meanwhile, so the tester `Write`s it headed `# Review` only when it is absent, otherwise changes only its own `## <phase-id>` block with `Edit`, never `Write`s it whole, and re-reads the file immediately before every `Edit`. Each verdict line is literally `**Verdict:** PASS` or `**Verdict:** FAIL`; a phase with any CRITICAL or MAJOR issue fails, and one with only MINOR issues passes with them listed under **Checked**.

```markdown
# Review

**Escalate: full** — <reason; whole-job `light` only, otherwise omitted>

## <phase-id>

**Verdict:** <PASS | FAIL>

**Checked:**
- `<command or file read>`: <what it showed>

**Disputed claims:**
- <claim from the result file that the reviewer could not confirm, or None.>
```

### issues.md

The tester writes this file only when a phase fails, and only in its final write, together with the verdicts: whole-job mode writes it whole, one block per failing phase; single-phase mode changes only its own phase's block and removes an earlier one on `PASS`. A fix pass reads `issues.md` cold, with no memory of the earlier pass, so each section repeats everything the fixer needs and points back to its plan section.

```markdown
# Issues

## <phase-id>

**Plan:** `plan.md#<phase-id>`

**Previous result:** `<phase-id>.result.md`

### <issue-id>
- **Location:** `<path>`, <symbol or section>
- **Problem:** <[CRITICAL | MAJOR | MINOR] what is wrong, observed not inferred>
- **Evidence:** `<command>` -> <output that shows the problem>
- **Fix:** <added acceptance criterion the fix must satisfy>
```

### scout.md and scout.result.md

An orient scout reads `request.md#job` and needs no `scout.md`. `scout.md` holds one section per question, written by the architect or by refuter main; a writer that finds the file present rewrites it whole with every earlier section kept. **Lane** is `codebase` when absent.

```markdown
# Scout

## <question-id>

**Question:** <one codebase or web question>

**Lane:** <codebase | web | both>

**Why:** <the decision it settles, and the asker's current belief>
```

`scout.result.md` is shared by scouts running in parallel. The dispatcher creates it, holding only the heading `# Scout results`, before the first spawn. Each scout changes only its own section, `## job` for an orient dispatch and `## <question-id>` for a question, with `Edit`, re-reads the file immediately before every `Edit`, re-appends its section if it went missing, replaces an earlier section with the same id, and never changes another section. **Verification commands** appears in the `job` section only. Anything looked for and not found is a **Gaps** entry, never a reason to stop.

```markdown
# Scout results

## <section-id>

**Findings:**
- `<path>`: <fact found: what it holds, key symbols, callers, convention to follow>
- <dated web fact> — <URL or library id>, retrieved <YYYY-MM-DD>

**Verification commands:**
- `<build, typecheck, lint, or test command>`: <where it is defined>

**Gaps:**
- <item looked for and not found, with where it looked; or None.>
```

### opinion.md

`opinion.md` is shared by experts running in parallel. Main creates the file, holding only the heading `# Opinion`, before the first `Consult` dispatch; experts never `Write` it whole. Each changes only its own `## <phase-id>` section with `Edit`, re-reads the file immediately before every `Edit`, re-appends its section if it went missing, and never changes another section. The expert records the sampled majority answer at the end of each Claim cell, so main can tell which side sampling supports.

```markdown
# Opinion

## <phase-id>

| Claim | Risk (0-1) | Samples |
|---|---|---|
| <claim from review.md> — majority: <answer> | <spanda risk> | <K> |
```

## Skill delivery

Workers lose the `Skill` tool and the `skills:` frontmatter preload. A worker gets a skill's text by reading a file that main copied into the job folder.

**Chosen: copy into the job folder.** At job start, main locates each needed `SKILL.md` (for example `baton/skills/git-diff/SKILL.md` or `rust/skills/rust/SKILL.md`, inside the plugin cache or a `--plugin-dir` folder) and copies it to the job folder's `skills/<name>.md` before any dispatch. The plan phase lists those project-relative paths under **Skills**, and the worker reads them with `Read`.

Reason: worker reads stay inside the project, so no worker hits a permission prompt, and any prompt for reading the plugin cache lands on main, the only agent a human is watching.

**Rejected: absolute SKILL.md paths in plan.md.** In this option, main resolves absolute paths with `Glob` and writes them into `plan.md`. It is rejected for three reasons. `${CLAUDE_PLUGIN_ROOT}` does not expand in a file read at runtime. The cache path `~/.claude/plugins/cache/<marketplace>/<product>/<version>/` changes with every plugin update and differs under `--plugin-dir` or `CLAUDE_CODE_PLUGIN_CACHE_DIR`. Every worker read outside the working directory triggers a permission prompt that no human is watching.

**Skills on pi.** The pi orchestrator's *Conductor runtime* block lists the skill roots, taken from pi core's `pi.skills` entries, which point at `claude/plugins/*/skills`. The orchestrator copies `<skill root>/<name>/SKILL.md` to the job folder's `skills/<name>.md`, the same shape as on Claude.

## Script delivery (pi only)

pi workers receive no package-root environment variable, so they cannot locate the scripts shipped with the packages. The pi refuter orchestrator therefore copies the self-contained `spanda-audit.py` (shipped in `claude/plugins/team/scripts/`) into the job folder's `scripts/`, and the pi expert runs it from there. Claude agents keep their `${CLAUDE_PLUGIN_ROOT}` paths and do not use `scripts/`.
