# Job-file contract

This document is the authoring spec for the transactional job-file protocol used by the conductor and refuter products on the Claude and pi harnesses.

Every dispatch is one line, `<Verb> <file>#<anchor>.` (the analyst's `Answer` mode aside, see Triage), whose substance lives in job files: the worker reads one input section and the job files its role's read rules add, does the work, writes one result file, and replies with one line. A worker that replied is finished, but main may resume it by its agent ID (see Review cycle); job files stay the source of truth, so a resume that fails is replaced by a fresh dispatch and never loses a result. Main is the only agent that talks to the human. On pi, the orchestrator (`pi/conductor/orchestrator.md`, `pi/refuter/orchestrator.md`) plays the role of main.

Both products dispatch the same five workers, shipped by the `team` plugin: `team:analyst`, `team:architect`, `team:developer`, `team:reviewer`, and `team:consultant` on Claude (`claude/plugins/team/agents/`), the bare names `analyst`, `architect`, `developer`, `reviewer`, and `consultant` on pi (`pi/team/agents/`). The conductor dispatches all but `consultant`; the refuter dispatches all five.

Workers take their input from files because subagents do not get `TaskGet` or `TaskUpdate` (Claude Code 2.1.283). The task list remains main's own status board and is never a worker's input.

## Agents cannot read this document

Installed plugins cannot read the repository's `docs/` folder at runtime. Each agent prompt therefore carries its own part of this contract: its row of the role table, the schema of the file it reads, the schema of the file it writes, the dispatch grammar, and the reply grammar. The conductor and refuter prompts embed the same Triage criteria. When this document changes, every agent prompt that embeds the changed part changes with it.

## Locations

| Product | Job root | Replaces |
|---|---|---|
| conductor | `.claude/conductor/jobs/` | worker dossiers held in task descriptions |
| refuter | `.claude/refuter/jobs/` | the refuter's former single plan file |

Each active job has its folder `.claude/<product>/jobs/<job-id>/`. The refuter folder mirrors the conductor shape so that one set of schemas and one set of worker prompts serves both products. In the refuter, the job folder's `plan.md` replaces the refuter's former single plan file, which is no longer written.

Both products share one environment file, `.claude/environment.md`, which is user-owned and lives outside every `jobs/` folder. Whichever orchestrator runs first generates it once when it is absent, writing the probed fields under its single `# ENVIRONMENT DETAILS` section; thereafter it is user truth. Workers read it on demand for OS, editor, and toolchain facts and never write it. The job lifecycle never edits or deletes it.

`jobs/` is ignored by git through the repository's root `.gitignore`. A repository that syncs job history un-ignores `jobs/archive/` alone, so active job folders and `jobs/local/` are never tracked.

### Folder layout

```text
.claude/<product>/jobs/<job-id>/
  request.md               # main: preamble and the human's goal, written at job start
  plan.md                  # architect: one anchored section per phase
  analyst.md               # architect, or refuter main: analyst questions, one anchored section each
  analyst.result.md        # analyst: a job section at orient, one section per question
  <phase-id>.result.md     # developer: one file per phase
  review.md                # reviewer: one block per phase with its verdict
  issues.md                # reviewer: one block per failing phase, the fixes a fix pass must make
  opinion.md               # refuter consultant: per-claim risk
  agents.md                # main, Claude only: agent IDs of kept workers
  skills/<name>.md         # main: copied SKILL.md text for workers
  scripts/<script>         # pi only: pi orchestrator's copies of the scripts workers run
.claude/<product>/jobs/archive/index.md                   # OKF bundle index, newest job first
.claude/<product>/jobs/archive/<YYYY-MM-DD>-<slug>.md     # OKF job note, tracked
.claude/<product>/jobs/archive/references/                # retained artifacts, type: reference
.claude/<product>/jobs/local/<YYYY-MM-DD>-<slug>/         # raw folder, never tracked
```

A file appears only when its role runs. The path the request takes (see Triage) bounds the folder: the answer path creates no folder at all; the direct path holds `request.md`, `plan.md`, and one `<phase-id>.result.md` (plus `skills/`, and on the refuter its review files); the full path may hold every file above. `<phase-id>` is a lowercase kebab-case slug that is unique within the job, for example `p1-job-file-contract`.

## Lifecycle

1. **Job start.** On the direct and full paths (the answer path has no job), main generates `<job-id>` as `YYYYMMDD-HHMM-<4 lowercase hex>`, independent of any session id, runs `mkdir -p .claude/<product>/jobs`, then a plain `mkdir` of the job folder, which fails if it exists; main then picks new hex, so sessions never share a folder. Main writes `request.md` and copies the needed skills into `skills/` (see Skill delivery); on pi, the refuter orchestrator also copies worker scripts into `scripts/` (see Script delivery).
2. **Work.** Main dispatches workers one line at a time. Each worker reads its input file, writes its output file, and replies.
3. **Job end.** After the final gate, main saves memory first and deletes every task it created, then:
   1. Names the record `<name>` = `<YYYY-MM-DD>-<slug>`: the archive day, then a lowercase kebab-case summary of the initial prompt, five words at most, suffixed `-2`, `-3`, ... while `jobs/archive/<name>.md` or `jobs/local/<name>/` exists or `git log --all --format=%h -1 -- .claude/<product>/jobs/archive/<name>.md` prints anything. The check covers every local and fetched ref, so a name taken on another branch is not reused; it is read-only, and main still never stages, commits, or pushes.
   2. Writes the OKF job note `jobs/archive/<name>.md` (see Job note).
   3. Inserts `* [<title>](<name>.md) - <description>` as the first entry under `# Jobs` in `jobs/archive/index.md`, creating the file with frontmatter `okf_version: "0.2"` only and a `# Jobs` heading when absent.
   4. Runs `mv .claude/<product>/jobs/<job-id> .claude/<product>/jobs/local/<name>` (after `mkdir -p .claude/<product>/jobs/local`) and tells the human to commit `jobs/archive/` and memory in their own commit, apart from project changes, before removing the worktree.

**Ownership.** A session never touches a job folder it did not create.

**Resume on request.** Only when the human asks, main lists active folders (`jobs/*/` except `archive/` and `local/`) with job id and `## job` **Goal**, adopts the one picked, reads `plan.md` and the existing result files and continues from the first phase without a `COMPLETE` result. A result file that still opens with `**Status:** in progress` is salvage, not `COMPLETE`. Main creates tasks for the remaining phases in its own list.

**Archive on request.** For a job left aside, main appends `**Closed incomplete:** <YYYY-MM-DD>` to its `request.md` preamble, saves memory, and closes it with the Job end steps, its note carrying `outcome: incomplete`.

**Memory.** Main alone writes memory: after reading the job's result files, it saves durable, non-obvious facts as notes in its own memory vault. Workers write none.

**Archived jobs.** `jobs/archive/` is an OKF bundle: the job note is the record of an ended job and, where `jobs/archive/` is tracked, the only part that syncs between machines. The raw folder stays under `jobs/local/` on the machine that ran the job; folders archived before the job-note format are also in git history before the migration commit. No agent walks `jobs/archive/` or `jobs/local/`; main opens an archived note only when a memory note names it.

**Task lists** are per session on both harnesses. Claude uses its default, with no project-wide `CLAUDE_CODE_TASK_LIST_ID`; pi's engine task store is keyed by the pi session id. Resuming the same session keeps its list; Claude `/clear` and pi `/new` or `/fork` start a new one.

## Anchors

Each section that a dispatch can address is a level-2 heading whose text is its anchor, written exactly as the slug: `## p1-job-file-contract`. The anchor in a dispatch matches that heading text verbatim. A file with a single subject uses the anchor `job`. A phase **Context** citation `analyst.result.md#<surface-slug>` is not a dispatch anchor: it names a level-3 **Findings** group (see analyst.md and analyst.result.md).

## Dispatch grammar

Main, or the spawning worker named in the role table, sends exactly one line:

```text
<Verb> <file>#<anchor>.
```

`<file>` is the project-relative path of a file in the job folder, e.g. `Plan .claude/conductor/jobs/20260101-0900-a3f9/request.md#job.` That file's directory is the worker's job folder: every path it reads or writes (section, sibling results, skills, scripts) and every analyst dispatch it sends resolves there, in the same full-path form. The worker reads that section of that file, plus any file the section names and the job files its role's read rules add (see Role table).

| Verb | Role | Example |
|---|---|---|
| `Analyze` | analyst, orient | `Analyze .claude/<product>/jobs/<job-id>/request.md#job.` |
| `Analyze` | analyst, one question | `Analyze .claude/<product>/jobs/<job-id>/analyst.md#q1-plugin-cache-path.` |
| `Answer` | analyst, answer path (no job folder) | `Answer Which files does the drift guard read the Surface line from?` |
| `Plan` | architect | `Plan .claude/<product>/jobs/<job-id>/request.md#job.` |
| `Implement` | developer | `Implement .claude/<product>/jobs/<job-id>/plan.md#p1-job-file-contract.` |
| `Fix` | developer, one phase | `Fix .claude/<product>/jobs/<job-id>/issues.md#p1-job-file-contract.` |
| `Fix` | developer, every open block (after a whole-job review) | `Fix .claude/conductor/jobs/<job-id>/issues.md#job.` |
| `Review` | reviewer, whole job (conductor) | `Review .claude/conductor/jobs/<job-id>/plan.md#job.` |
| `Review` | reviewer, one phase (refuter) | `Review .claude/refuter/jobs/<job-id>/plan.md#p1-job-file-contract.` |
| `Recheck` | kept reviewer, resumed (Claude only) | `Recheck .claude/<product>/jobs/<job-id>/plan.md#job.` or `...plan.md#p1-job-file-contract.` |
| `Consult` | consultant (refuter only) | `Consult .claude/refuter/jobs/<job-id>/review.md#p1-job-file-contract.` |

The dispatch is a pointer and nothing else: every fact the worker needs lives in the job file it points at, never in the dispatch text. The one exception is `Answer <question>`, which carries a one-line question inline because the answer path has no job folder to point at (see Triage). Keep the `<file>#<anchor>` token first after the verb: on pi, `pi/core/extensions/engine/drift-config.ts` regex-parses the first `plan.md#<anchor>` or `issues.md#<anchor>` token from the dispatch text to find the phase's **Surface**.

`Recheck` is the one verb not sent as a spawn: main sends it with `SendMessage` to the agent ID of a kept reviewer (see Review cycle). Workers never call `SendMessage`; a worker's final reply is its message to main.

**Worker-to-worker resume is not wired.** Resuming a warm analyst would let the architect ask follow-ups at cache price, but workers have no `SendMessage` in their frontmatter, and pi spawns each worker as a `--no-session` process that cannot be resumed. The architect therefore answers a follow-up from the orient map (`analyst.result.md#job`) first and spawns a fresh question analyst only for a question the map cannot answer. Main's `Recheck` resume of the kept reviewer (see Review cycle) is unchanged.

## Reply grammar

A worker's final message is exactly one line whose first token is `COMPLETE` or `BLOCKED:`, one of:

```text
COMPLETE — <routing summary>
BLOCKED: <reason>
```

`<reason>` is one sentence that names what is missing or contradictory. A worker that replies `BLOCKED: <reason>` still writes its output file with whatever it established.

After `COMPLETE` comes ` — ` and a fixed per-role routing summary of `key value` pairs separated by `; `, every value a count or a fixed word taken from the worker's own output file:

| Role | Reply |
|---|---|
| analyst | `COMPLETE — <job\|question-id\|answer>: surfaces <n>; gaps <n>; notes <n>; change <yes\|no>` — `surfaces`: distinct paths under **Findings**; `gaps`: **Gaps** entries; `notes`: **Notes** entries; `change`: the job section's **Change indicated** (job and answer replies only; a question reply omits it) |
| architect | `COMPLETE — phases <n>; tier <none\|light\|full>; unknowns <n>` — `unknowns`: phases whose **Unknowns** is not `None.` |
| developer | `COMPLETE — <phase-id>: files <n>; interfaces <yes\|no>; decisions <n>; unknowns <n>; notes <n>` — `files`: **Changed files** lines; `interfaces`: whether `## Interfaces` is not `None.`; `decisions`: **Decisions** entries; `unknowns`: **Gaps** entries; `notes`: **Notes** entries |
| reviewer | `COMPLETE — <phase-id\|job>: <pass\|fail>; issues <n>` — `fail` when any verdict it wrote is `FAIL`; `issues`: issue blocks it wrote to `issues.md` |
| consultant | `COMPLETE — <phase-id>: claims <n>; scored <n>; n/a <n>` — `claims`: rows of its `opinion.md` table; `scored`: rows with a numeric **Risk (0-1)**; `n/a`: rows whose risk is `n/a (...)` |

**Answer mode.** An analyst dispatched with `Answer <question>` writes no file. Its reply is the analyst line, `COMPLETE — answer: surfaces <n>; gaps <n>; notes <n>; change <yes|no>`, followed by a body of at most 40 lines holding its findings, gaps, and notes in the `analyst.result.md` shapes; this is the one exception to the one-line rule, and main answers the human from the body. `change yes` there is report-only: main tells the human a change looks indicated and starts no job unless the human asks for one.

Main reads the output file whole before routing; the summary only cross-checks it. The one exception is the conductor's orient map: on `change yes` the conductor routes to `Plan` from the reply alone and leaves `analyst.result.md#job` to the architect. The reviewer's summary never replaces its file: the `**Verdict:**` lines in `review.md` stay binding, and when the reply and the file disagree the file wins and the reply is a defect. The consultant measures agreement and never rules on a claim, so its summary counts scored rows, not claims upheld or overturned; main still reads `opinion.md` to rule.

A reply whose first token is neither `COMPLETE` nor `BLOCKED:` is a protocol violation, and main treats it as `BLOCKED`. A bare `COMPLETE` with no summary is still complete, since main reads the output file whole either way, which keeps fake workers that echo a bare `COMPLETE` (`pi/scripts/worker-guard-harness.mts`) valid. The one-line rule binds worker-authored replies; the pi guard reply below is engine-authored and keeps its multi-line trace. On pi's Chain mode, `{previous}` substitutes the prior worker's final output, so a chain carries forward only the one-line reply; main still reads each chained worker's output file whole before routing on it.

On pi, the engine kills a worker that issues the same tool call three times in a row, and replies for it `BLOCKED: <guard> — <reason>` followed by its last tool calls. No agent on either harness sets a turn cap. On pi, a drift nudge running inside each child steers a worker that repeats searches or results, or (for `developer`) goes 40 calls without a Surface edit, with a `[drift]` message to take a concrete next step or write its result as `BLOCKED` with Gaps; it never kills.

**Rolling output.** Every worker except an `Answer` analyst keeps its output current while it works, so a stopped worker leaves its established findings on disk. It creates its output file early, or adds its own section to a shared file (`analyst.result.md`, the single-phase reviewer's `review.md`, `opinion.md`, each written under the rule in its schema below), and its first line is the marker:

```text
**Status:** in progress
```

After each confirmed finding or completed step, the worker updates the file with what is established and its next intended step, at milestones rather than after every tool call. Until the final write, a verdict-bearing file holds findings only: `review.md` has no `**Verdict:**` line, `plan.md` has no phase table or phase section to dispatch from, and `opinion.md` has no claim table. `issues.md` is written only in the final write, together with the verdicts, never while the marker stands. The final write replaces the file or section whole in its normal schema, without the marker.

**Salvage.** A `COMPLETE` reply, with or without its summary, whose output file or section still opens with the marker counts as `BLOCKED`. On `BLOCKED`, a guard kill or stopped worker, or a missing or garbled reply, main reads the output file if it exists and copies a marked file's established facts into the worker's input section as needing no re-reading, the one edit allowed to a section after its dispatch apart from appended `plan.md#job` **Revision** lines (the fold-back under Role table is made before a dispatch, never after it); with no file, it uses the guard's trace. It then corrects or narrows the section and spawns the worker fresh, never reading a marked file as a result, verdict, or plan. The refuter phase cycle's own handling wins: after consultant `BLOCKED` main rules on the reviewer alone, and after reviewer `BLOCKED` it surfaces a marked `review.md` section as partial findings. The architect, the one dispatching worker, applies the same rule to its `analyst.result.md` sections, copying the facts into a new `analyst.md` question section.

`plan.md` has no Gaps section; a worker writing it that has something to flag replies `BLOCKED: <reason>` instead.

## Role table

The "Spawned by" column names the only agent that dispatches the role.

| Product | Harness | Role | Input file | Output file | Spawned by |
|---|---|---|---|---|---|
| conductor, refuter | Claude, pi | analyst | orient: `request.md#job`; question: `analyst.md#<question-id>`; answer: the dispatch line | `analyst.result.md#job` or `analyst.result.md#<question-id>`; answer: none, the reply body | orient and answer: main; question: architect, or refuter main |
| conductor, refuter | Claude, pi | architect | `request.md#job` plus `analyst.result.md#job` when present | `plan.md` | main |
| conductor, refuter | Claude, pi | developer | `plan.md#<phase-id>`; fix pass: `issues.md#<phase-id>`, or `issues.md#job` for every open block; plus `request.md#job` **Goal** and **Constraints**, the `analyst.result.md` sections its **Context** cites by anchor, and the `## Interfaces` and `**Decisions:**` of each "Depends on" phase's `<phase-id>.result.md` | `<phase-id>.result.md`, one per fixed phase | main |
| conductor | Claude, pi | reviewer, whole job | `plan.md#job`, every full `plan.md#<phase-id>` section, every `<phase-id>.result.md` with its `**Decisions:**`, plus `request.md#job` **Constraints** | `review.md`, plus `issues.md` when any phase fails | main |
| refuter | Claude, pi | reviewer, one phase | the full `plan.md#<phase-id>` section plus `<phase-id>.result.md` with its `**Decisions:**`, plus `request.md#job` **Constraints** | `review.md#<phase-id>`, plus `issues.md#<phase-id>` when the phase fails | main |
| refuter | Claude, pi | consultant | `review.md#<phase-id>` (its disputed claims) | `opinion.md#<phase-id>` | main |

The architect spawns its question analysts itself, not through main: it writes `analyst.md`, seeds `analyst.result.md` with `# Analyst results` when the file is absent, spawns one analyst per question, and reads their sections before it writes `plan.md`.

**Read rules.** The developer reads its phase section (or its `issues.md` block and the plan section and result file that block names), `request.md#job` **Goal** and **Constraints**, and, for each phase in its row's "Depends on" column of the `plan.md#job` index, the `## Interfaces` and `**Decisions:**` of that phase's `<phase-id>.result.md`; it never reads any other sibling output, and it reads `analyst.result.md` only in the `### <surface-slug>` groups its **Context** cites as `analyst.result.md#<surface-slug>`, never the map whole. The reviewer reads the full phase section, **Goal** and **Context** included, in both single-phase and whole-job modes, plus `request.md#job` **Constraints** and each result's `**Decisions:**`.

**Fold-back.** Main reads each worker's output file whole, then routes (the conductor's orient map on `change yes` aside, see Reply grammar); the reply summary is a cross-check, never a substitute (see Reply grammar). Any fact the next worker needs that exists only in main's reasoning is written into that worker's input file before dispatch: into `request.md#job` **Constraints** for the architect, into the phase section's **Context** or **Unknowns** for a developer. This append is the one edit main makes to a phase section before its dispatch; dispatch text never carries it.

The reviewer holds `Write` and `Edit`: in whole-job mode it overwrites `review.md` and, when a phase fails, `issues.md` whole; in single-phase mode it changes only its own phase's block in each.

## Triage

Before it creates a job, main puts the request on one of three paths by the criteria below. The process scales to the request: a question or a small named edit never runs the full pipeline.

**Read budget.** On the answer and direct paths main may read at most 3 files whose paths the request or its memory index names, at most 200 lines per read and 600 lines in total. It may `Glob` only a literally named path to confirm it exists, and never runs `Grep` or a pattern search.

**answer.** The request asks a question or asks to review, audit, check or explain, and requests no file change. Main answers within the read budget; when the budget cannot answer, it dispatches one `analyst` with `Answer <question>` and replies from its reply body (see Reply grammar). No job folder, no `request.md`, no `plan.md`, no archive.

**direct.** The request names at most two target files by path, each confirmed by one literal `Glob`, states the edit's content or behaviour, contains no search word (all, every, each, wherever, find, across, audit), and states no unknown. Main writes `request.md` and a direct-path `plan.md` (see plan.md) itself within the read budget, dispatches one `Implement`, runs the job's **Verification commands** itself once, trusts the result's recorded acceptance output, and then runs the final gate and Job end. Any one of these escalation triggers converts the job to the full path: the result's **Gaps** is not `None.`, a `BLOCKED` reply, a verification command failing, or `git diff --name-only <Diff base>` listing a file outside **Surface**. Main then writes the trigger into `request.md#job` **Constraints** and dispatches `Analyze` then `Plan` on the same job folder.

**full.** Everything else: `Analyze`, then `Plan`, then the implementation and review cycle.

**Early exit.** After `Analyze` on the full path, when the analyst reply carries `change no` (the orient map shows no change is indicated, or the map itself answers the request), main reports from `analyst.result.md#job`, dispatches no `Plan`, and runs Job end.

**Refuter.** The refuter's Direct tier is the direct path but keeps its single-phase `Review` and `Consult`, since adversarial review is the refuter's purpose; its Lightweight and Full tiers are the full path. On its direct path refuter main never runs the **Verification commands** itself: the one phase's **Acceptance criteria** list each **Verification commands** entry, so the developer runs them once and records the output, and main checks the escalation triggers from the result file (**Gaps**, a `BLOCKED` reply, a **Changed files** entry outside **Surface**) and a failing command in the result's Verification table or in `review.md#<phase-id>`.

## Review cycle

A fix pass is a fresh developer spawn that reads `issues.md` cold. The reviewer is the only worker main resumes; the `Fix` developer and the refuter's `Consult` consultant stay fresh spawns.

**Verify once.** Each check is paid for once, then its recorded evidence is trusted. The developer runs its phase's acceptance commands and records each one's output in its result file, and does not re-run the analyst's exploratory probes. The whole-job reviewer, the tier-`none` check, the conductor's direct-path run, and the refuter's direct-path developer (through its phase's **Acceptance criteria**) execute the job's **Verification commands** once, and re-run an acceptance command only when its recorded output is missing, is contradicted by the diff or another result file, or covers files a later phase touched. A `Recheck` still re-runs the fixed phases' acceptance criteria, since a fix invalidates their recorded output.

**Resume (Claude).** Main resumes a worker that replied with `SendMessage`, addressed to the agent ID from the `Agent` launch result (`agentId`) or the `task-notification` `task-id`. The resumed run keeps its full history and tool set; inside the 5-minute subagent prompt-cache window it reads the original run's cache, and after it the history is written to cache again, cold but still correct. A subagent the user stopped from `/tasks` refuses messages. Right after each `Review` reply, main writes or replaces the reviewer's row in `agents.md` with `State` `kept`.

**Recheck.** `Recheck plan.md#<anchor>.` (`job` for whole-job, `<phase-id>` for single-phase) goes only to a kept reviewer, after the `Fix` developer replies `COMPLETE`. The reviewer re-verifies every issue it wrote for that anchor in `issues.md`, re-reads in full every file under **Changed files** of each fixed result file (`<phase-id>.result.md`), and re-runs each fixed phase's **Acceptance criteria**, marks each earlier issue fixed or still open, adds any new issue found in those files, then writes its verdict exactly as a `Review` does: single-phase edits only its own blocks; whole-job rewrites `review.md` whole and `issues.md` whole, the latter holding `# Issues` and the single line `None.` when no phase still fails. It replies with its reviewer line under Reply grammar, `COMPLETE — <phase-id|job>: <pass|fail>; issues <n>` or `BLOCKED: <reason>`. Main never deletes `issues.md` before a `Recheck`; it deletes it only before a fresh `Review`.

**Expiry.** Expiry is outcome-based, never time-based: a cold resume is correct and about cost-neutral. Main sends `Recheck` whenever `agents.md` holds a `kept` row for the reviewer and the anchor. When `SendMessage` returns an error or a cancelled notice, or the modification time of `review.md` (`stat -c %Y`, read right before the `Recheck` and again after the reply) is unchanged, main sets the row's `State` to `expired` and dispatches a fresh `Review`, which replaces the row after its reply.

**pi.** The pi `subagent` tool spawns a fresh `pi --mode json -p --no-session` process per call and takes no session ID or message, so pi orchestrators stay on fresh dispatch: they never write `agents.md` and run a fresh `Review` after every `Fix`, and the `Recheck` text in shared worker prompts is never sent there.

**Optional cache setting.** `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h` (or the `subagentPromptCacheTtl` setting) extends the subagent cache window so a `Recheck` after a long fix still reads cache, at a higher cache-write price; it is ignored while a subscription runs on usage credits. Baton does not set it.

**Conductor.** On the full path, before writing `request.md`, main reasons the work through — affected surfaces, dependency order, one alternative decomposition — and records the result in `request.md#job` **Constraints**; after `Analyze` it reads `analyst.result.md#job` only on `change no`, to take the early exit (see Triage), and otherwise dispatches `Plan` without reading the map, which the architect reads. When a review verdict contradicts it or one issue class recurs across two phases, main appends a **Revision** line to `plan.md#job` and re-dispatches `Plan`. Once every phase has a `COMPLETE` result, main applies the review-tier escalation, deletes any previous `issues.md`, and runs the effective **Review tier** (see plan.md). At `none`, main's mechanical all-green check passing leads to the final gate; otherwise the review tier rises to `light`. At `light` or `full`, main dispatches `Review plan.md#job.` to the reviewer in whole-job mode; a `light` review whose `review.md` preamble carries `**Escalate: full** — <reason>` makes main append a `full` **Revision** line and dispatch Review again before acting on any verdict. Verdicts are binding: main reads each `**Verdict:**` line literally, counts a missing or malformed one as `FAIL`, and never overrides, downgrades, or skips a `FAIL`. Every verdict `PASS` leads to the final gate. On a `FAIL` in one phase block, main dispatches `Fix issues.md#<phase-id>.`; on a `FAIL` in more than one phase block, it dispatches one `Fix issues.md#job.`, a fresh developer that fixes every open block in plan order and overwrites each fixed phase's `<phase-id>.result.md`. Main then sends `Recheck plan.md#job.` to the kept reviewer, or, with no `kept` row or on expiry, deletes `issues.md` and dispatches a fresh Review. A `FAIL` in the `job` block, a diff-wide finding no phase owns, gets no `Fix`: failing phases are fixed and re-reviewed first, and a `job` `FAIL` still standing after that goes to the human with its findings, and the job closes incomplete. Fix rounds have no cap: the loop repeats until every verdict is `PASS`, and the reviewer's findings win over the developer's claims. Only a `BLOCKED` review goes to the human with the findings from `review.md`.

**Refuter.** Each phase, the direct path's single phase included, runs `Implement`, then `Review plan.md#<phase-id>.` (the reviewer in single-phase mode), then `Consult` when `review.md#<phase-id>` lists disputed claims. Main rules on the verdict with the opinion, and on a remaining `FAIL` dispatches `Fix issues.md#<phase-id>.` to a fresh developer, followed by `Recheck plan.md#<phase-id>.` to the kept reviewer, or a fresh `Review` with no `kept` row or on expiry; `Consult` always spawns a fresh consultant. Fix passes have no cap: the cycle repeats until main accepts the phase.

## Schemas

Every schema below is a literal template. Placeholders are in angle brackets. A section with nothing to report contains the single line `None.`

### request.md

No worker reads the preamble above `## job`; its initial prompt gives the job note its slug. **Constraints** holds the limits the human stated, plus one clause per memory rule that binds the job, naming the rule rather than restating the note's text. Analyst **Gaps** are never copied into it: a Gap that blocks the goal reaches main as the analyst's `BLOCKED:` reply, and the rest stay report-only in `analyst.result.md`.

```markdown
# Request

**Job id:** <job-id>

**Initial prompt:** <the human's initial prompt, verbatim>

## job

**Goal:** <the human's goal in one or two sentences>

**Constraints:** <limits the human stated; one clause per binding memory rule; on the full path, your recorded reasoning: affected surfaces, dependency order, one alternative decomposition>

**Diff base:** <branch or commit that review diffs against>
```

### plan.md

`plan.md` starts with a `job` index section, then one anchored section per phase. Each phase section is self-contained, because a developer reads only its own section, `request.md#job`, the `analyst.result.md` groups its **Context** cites, and its dependencies' `## Interfaces` and `**Decisions:**` (see Role table). The architect writes the same schema for both products. The job-level **Acceptance criteria**, **Verification commands**, and **Review tier** are read by the conductor and the whole-job reviewer; the refuter's gate runs per phase and does not use them, beyond its direct-path phase listing the **Verification commands** under its **Acceptance criteria**.

**Rationale** applies to both products: the architect records there, in two to four sentences, the decisions its sequential thinking reached (see Skill delivery): why that review tier, the key decomposition or ordering decision, and the alternatives rejected with why. On the direct path main writes `plan.md` itself, and its **Rationale** is the one line `direct path`; refuter main writes **Rationale** only there, and on its Lightweight and Full tiers, where the architect writes it, only appends **Revision** lines.

**Size limits.** Each review tier caps the plan, checkable by `wc -l`: `none` is one phase and the whole file at most 60 lines; `light` is at most 3 phases and the whole file at most 160 lines; `full` is at most 45 lines per phase section.

**Direct-path plan.** On the direct path main writes `plan.md` itself, with no architect: the `## job` section holds **Goal**, **Rationale** `direct path`, **Review tier** `none`, **Diff base**, **Acceptance criteria**, **Verification commands**, and the phase table; the one phase section holds **Goal**, **Surface** (the named files), **Context**, **Out of scope**, **Acceptance criteria**, **Conventions**, and **Skills**. Fields the template below has and this list omits are left out. **Revision** lines are optional and main's alone: on each global re-plan or conductor review-tier escalation main appends one dated line to the end of the `job` section, never editing or deleting earlier **Rationale** or **Revision** text, so the original reasoning survives a resume.

**Review tier** is read by the conductor and the whole-job reviewer: `none`, `light`, or `full`, with a one-clause reason, set by the architect from the "When" column below; the conductor never lowers it and raises it only by an appended **Revision** line, and **Rationale** names why. An absent field means `full`.

| Review tier | When | What runs |
|---|---|---|
| `none` | Docs, prompts, config, copy, or mechanical single-surface edits where every acceptance item is checkable by one command | No review dispatch: main runs a mechanical all-green check from the repo root — it runs every **Verification commands** entry plus `git diff --name-only <Diff base>` and `git diff --stat <Diff base>`, and reads every result file whole, Verification table included; every command exits 0, every file in `git diff --name-only <Diff base>` lies inside some phase's **Surface**, every Verification row is a pass, and every result file's **Gaps** is `None.` (its **Notes** never count) — and never judges code; it re-runs an acceptance command only under the verify-once rule (see Review cycle); anything else raises the review tier to `light` |
| `light` | Moderate code changes inside one surface, no public interface changed | the reviewer on changed hunks and one-hop callers, plus the **Verification commands** run once and every acceptance criterion checked against its recorded output under the verify-once rule; pi's `subagent` takes no per-call model, so there `light` saves cost through narrower scope only |
| `full` | Public API, schema, migration, security, or concurrency changes, parallel phases sharing an interface, and every review the human requested alongside a change, whatever the field says (a review with no requested change takes the answer path, see Triage) | the reviewer reads every touched file whole and traces every caller |

The architect picks the lowest review tier whose "When" fits every phase; any phase meeting a `full` trigger makes the job `full`. **Escalation:** once every phase is `COMPLETE`, main checks these triggers: a result file whose **Gaps** is not `None.` (escalation fires on **Gaps** only, never on **Notes**), a file in `git diff --name-only <Diff base>` outside every phase's **Surface**, or a failing verification command raises the review tier one step; a file in `git diff --name-only <Diff base>` on a public interface, schema, migration, security, or concurrency path raises it to `full`; the reviewer's `**Escalate: full**` line raises it to `full`. **Review tier** stays as planned: main records each escalation as an appended `**Revision:** <YYYY-MM-DD> — review tier <light|full>: <trigger>` line, and the effective review tier is the latest such line, else **Review tier**. A fix round re-reviews at the effective review tier and never lowers it.

**Surface** is one line holding a backticked list of the paths or directories the phase owns, never a prose area: on pi the drift guard reads only that line and keeps only backticked tokens containing a `/` or `\`, so a top-level file is written `./CHANGELOG.md`. **Context** cites the orient map by anchor, `analyst.result.md#<surface-slug>` for each Findings group the phase needs, plus at most 5 copied facts (a roster, a line-ending rule, a fact the phase turns on), never the map's text wholesale; on the direct path, where there is no map, it holds the facts from main's own bounded reads. Anchors are path plus heading or symbol; line numbers appear only as orient-time hints the developer re-verifies. **Research** stays for dated web and library facts, each with its source. The architect never lists changed files: it does not pre-write the diff, and the owning paths in **Surface** are not a changed-files list.

**Model:** is an optional last line of a phase section, after **Research**, omitted unless set. The architect sets it only as an escape hatch for one phase, never by default or as a by-tier policy, and records why in **Rationale**. Its value is one of `opus`, `sonnet`, `haiku`, `fable`. On Claude the conductor and refuter pass it as `model: "<value>"` on that phase's `Implement` and `Fix` dispatches only and never re-judge it; the conductor's multi-phase `Fix issues.md#job.` carries it only when every phase it covers has the same value. Every other dispatch (`Analyze`, `Plan`, `Review`, `Recheck`, `Consult`) passes no `model:`, the resumed reviewer of a `Recheck` keeps its first run's model, and every worker otherwise runs on its own agent file's frontmatter model. The conductor's and refuter's pre-dispatch check rejects any other value as a defect of that phase section and does not dispatch it. pi passes no per-call model, so there the line is documentation only.

```markdown
# Plan

## job

**Goal:** <the job goal>

**Rationale:** <the decisions your sequential thinking reached: why that review tier, the key decomposition or ordering decision, and the alternatives rejected with why>

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

**Surface:** `<path or directory this phase owns>`, `<path or directory>`

**Context:** <requirements; `analyst.result.md#<surface-slug>` anchors; at most 5 copied facts: `<path>` — <heading or symbol>: <fact>, a roster, a line-ending rule; line numbers only as hints to re-verify>

**Out of scope:** <paths and areas the worker must not change>

**Unknowns:** <open questions the worker must resolve or report, or None.>

**Acceptance criteria:**
- <checkable criterion, ideally a command and its expected output>

**Conventions:** <names of the skills that apply, e.g. rust, typescript, or None.>

**Skills:**
- `.claude/<product>/jobs/<job-id>/skills/<name>.md`

**Research:** <dated facts from the analyst, each with its source, or None.>

**Model:** <opus | sonnet | haiku | fable; optional, the line is omitted unless set>
```

### `<phase-id>.result.md`

The developer writes this file. A fix pass overwrites it with the full current state, not a delta. **Decisions** is required and comes first, so the reviewer and dependent developers read it before the diff: every choice the plan left open and every deviation from the plan, each with its reason, or `None.`. Each **Changed files** line carries the symbol or heading it changed, so the reviewer and a dependent phase can go straight to it. **Verification** is mandatory and holds one row per acceptance command with its recorded output, trimmed to the lines that prove the result; that record is what the verify-once rule trusts (see Review cycle). **Gaps** holds doubts about this phase: an unmet criterion, a plan error, an unconfirmed claim, or an assumption made; it may escalate the review. **Notes** holds observations outside the phase's scope; it is report-only and never escalates, and nothing in it becomes work unless the human asks.

```markdown
# <phase-id> result

**Decisions:**
- <choice made, or deviation from the plan with the reason; or None.>

## Changed files
- `<path>` — <symbol or heading>: <what changed>

## Interfaces
- `<symbol or file>`: <added | changed>, <shape later phases depend on>

## Verification
| Command | Result |
|---|---|
| `<command>` | <pass or fail, with the recorded output, trimmed, that proves it> |

## Gaps
- <unmet criterion, plan error, unconfirmed claim, or assumption made about this phase; or None.>

## Notes
- <observation outside this phase's scope, report-only; or None.>
```

### review.md

The reviewer writes it in one of two modes. Whole-job (conductor): it is the only writer and overwrites the file whole, one block per phase plus a `job` block in the same shape for diff-wide checks, and, only at `light` when the diff meets a `full` trigger, one `**Escalate: full** — <reason>` line in the preamble. Single-phase (refuter): consultants of other phases may read the file meanwhile, so the reviewer `Write`s it headed `# Review` only when it is absent, otherwise changes only its own `## <phase-id>` block with `Edit`, never `Write`s it whole, and re-reads the file immediately before every `Edit`. Each verdict line is literally `**Verdict:** PASS` or `**Verdict:** FAIL`. In whole-job mode (conductor), a phase with any CRITICAL or MAJOR issue fails, and one with only MINOR findings passes with them listed under **Checked**; in single-phase mode (refuter), any standing issue, MINOR included, fails.

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

The reviewer writes this file only when a phase fails, and only in its final write, together with the verdicts: whole-job mode writes it whole, one block per failing phase; single-phase mode changes only its own phase's block and removes an earlier one on `PASS`. A fix pass reads `issues.md` cold, with no memory of the earlier pass, so each section repeats everything the fixer needs and points back to its plan section. The file has no `## job` block: the anchor `job` addresses the whole file, the `# Issues` heading and every `## <phase-id>` block below it, which `Fix issues.md#job.` fixes in plan order.

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

### analyst.md and analyst.result.md

An orient analyst reads `request.md#job` and needs no `analyst.md`. `analyst.md` holds one section per question, written by the architect or by refuter main; a writer that finds the file present rewrites it whole with every earlier section kept. **Lane** is `codebase` when absent.

```markdown
# Analyst

## <question-id>

**Question:** <one codebase or web question>

**Lane:** <codebase | web | both>

**Why:** <the decision it settles, and the asker's current belief>
```

`analyst.result.md` is shared by analysts running in parallel. The dispatcher creates it, holding only the heading `# Analyst results`, before the first spawn. Each analyst changes only its own section, `## job` for an orient dispatch and `## <question-id>` for a question, with `Edit`, re-reads the file immediately before every `Edit`, re-appends its section if it went missing, replaces an earlier section with the same id, and never changes another section. **Verification commands** and **Change indicated** appear in the `job` section only. **Findings** comes last in its section and is grouped under `### <surface-slug>` sub-headings, lowercase kebab-case and unique within the file, so a phase **Context** can cite `analyst.result.md#<surface-slug>`; a group runs to the next heading. Each codebase finding carries an anchor the plan can cite verbatim: the path plus a heading or symbol, with a line number only as an orient-time hint. **Gaps** holds what was looked for and not found, request premises the code contradicts, and areas left unmapped; a Gap is never a reason to stop, except one that blocks the goal, which the analyst reports as a `BLOCKED:` reply and main never copies into `request.md`. **Notes** holds observations outside the question, report-only. **Change indicated** is `yes`, or `no` with the reason when nothing needs changing or the findings themselves answer the request; it drives the early exit (see Triage). **Rosters** lists the sets of files that must change together; **Line endings** names the line-ending rule each touched file type follows.

```markdown
# Analyst results

## <section-id>

**Change indicated:** <yes | no — reason; job section only>

**Rosters:**
- `<path>`, `<path>`: <why they change together; or None.>

**Line endings:**
- <file pattern>: <rule and where it is set, e.g. `*.md text eol=crlf` in `.gitattributes`; or None.>

**Verification commands:**
- `<build, typecheck, lint, or test command>`: <where it is defined>

**Gaps:**
- <item looked for and not found with where it looked, a request premise contradicted, or an area left unmapped; or None.>

**Notes:**
- <observation outside the question, report-only; or None.>

**Findings:**

### <surface-slug>
- `<path>` — <heading or symbol>: <fact found: what it holds, callers, convention to follow>
- <dated web fact> — <URL or library id>, retrieved <YYYY-MM-DD>
```

### opinion.md

`opinion.md` is shared by consultants running in parallel. Main creates the file, holding only the heading `# Opinion`, before the first `Consult` dispatch; consultants never `Write` it whole. Each changes only its own `## <phase-id>` section with `Edit`, re-reads the file immediately before every `Edit`, re-appends its section if it went missing, and never changes another section. The consultant records the sampled majority answer at the end of each Claim cell, so main can tell which side sampling supports.

```markdown
# Opinion

## <phase-id>

| Claim | Risk (0-1) | Samples |
|---|---|---|
| <claim from review.md> — majority: <answer> | <spanda risk> | <K> |
```

### agents.md

Main alone writes `agents.md`, on Claude only; no worker reads it. It holds one row per kept worker, keyed by role and anchor. `State` is `kept` after the worker's reply and `expired` after a failed resume; a fresh dispatch for the same role and anchor replaces the row. Main records a reviewer row right after each `Review` reply, in one `Edit` or `Write` call.

```markdown
# Agents

| Role | Anchor | Agent ID | State |
|---|---|---|---|
| reviewer | plan.md#job | <agent id> | kept |
```

### Job note

Main writes `jobs/archive/<name>.md` at Job end, 20 to 60 lines distilled from `request.md`, `plan.md#job`, `review.md` and the result files' `**Decisions:**`, never a result file copied wholesale. It is an Open Knowledge Format (OKF) v0.2 concept: `type` is the only key OKF requires, the other keys are producer keys, and the outcome is `outcome`, never `status`, which OKF reserves for `draft|stable|deprecated`. `<product>` is `conductor` or `refuter`. A note migrated from a legacy raw folder may carry `outcome: unknown`, omit `job_id` when the folder did not record it, and title its source `raw job folder (untracked; in git history before the migration commit)`.

```markdown
---
type: job
title: <slug words in sentence case>
description: <one sentence: what the job changed or decided>
job_id: <job-id>
archived: <YYYY-MM-DD>
outcome: <complete | incomplete>
tags: [job, <product>]
sources:
  - resource: ../local/<name>/
    title: raw job folder (untracked, on the machine that ran the job)
---

## Goal
<request.md **Goal**>

## Outcome
<review verdict and completion state>

## Decisions
<plan.md#job **Rationale** and each phase's **Decisions:**>

## Phases
| Phase | Goal | Verdict |
|---|---|---|
| <phase-id> | <goal> | <review verdict, or not run> |

## Memory
<memory notes this job wrote or updated, or None.>

## Artifacts
<files retained under references/, or None.>
```

`jobs/archive/index.md` is the bundle-root index: its only frontmatter is `okf_version: "0.2"`, then a `# Jobs` heading with one `* [<title>](<name>.md) - <description>` line per note, newest first, and a `## References` list when `references/` holds files.

## Skill delivery

Workers lose the `Skill` tool and the `skills:` frontmatter preload. A worker gets a skill's text by reading a file that main copied into the job folder.

**Chosen: copy into the job folder.** At job start, main locates each needed `SKILL.md` (for example `baton/skills/git-diff/SKILL.md` or `rust/skills/rust/SKILL.md`, inside the plugin cache or a `--plugin-dir` folder) and copies it to the job folder's `skills/<name>.md` before any dispatch. The plan phase lists those project-relative paths under **Skills**, and the worker reads them with `Read`.

Reason: worker reads stay inside the project, so no worker hits a permission prompt, and any prompt for reading the plugin cache lands on main, the only agent a human is watching.

**Sequential thinking.** Main copies the `baton` skill `sequential-thinking` to the job folder's `skills/sequential-thinking.md` only when it dispatches `Plan` (the conductor's full path; the refuter's Lightweight and Full tiers), before the first `Plan` dispatch, and never on the answer or direct path; no phase lists it under **Skills**. The architect reads it and follows its thought protocol inline to decompose the request, runs its native checklist (surfaces, dependency order, one alternative decomposition, revision) when the copy is absent, and records only the resulting decisions in **Rationale**. Refuter main follows the same protocol for its own planning on the Lightweight and Full tiers only: on Claude it invokes `baton:sequential-thinking` through `Skill`, on pi it reads the skill's `SKILL.md` from its skill listing. The conductor never uses the skill itself. No agent runs the skill's `scripts/think.ts` or writes the thought sequence out; on pi, where installed-package children see the skill in their listing, every bash-capable worker carries the guard "If you use the listed `sequential-thinking` skill, follow its thought protocol inline; never run its `scripts/think.ts`." The vendored skill comes unedited from thedotmack/sequential-thinking-skill at commit `d0fd5d4`, MIT.

**Rejected: absolute SKILL.md paths in plan.md.** In this option, main resolves absolute paths with `Glob` and writes them into `plan.md`. It is rejected for three reasons. `${CLAUDE_PLUGIN_ROOT}` does not expand in a file read at runtime. The cache path `~/.claude/plugins/cache/<marketplace>/<product>/<version>/` changes with every plugin update and differs under `--plugin-dir` or `CLAUDE_CODE_PLUGIN_CACHE_DIR`. Every worker read outside the working directory triggers a permission prompt that no human is watching.

**Skills on pi.** The pi orchestrator's *Conductor runtime* block lists the skill roots, taken from pi core's `pi.skills` entries, which point at `claude/plugins/*/skills`. The orchestrator copies `<skill root>/<name>/SKILL.md` to the job folder's `skills/<name>.md`, the same shape as on Claude.

## Script delivery (pi only)

pi workers receive no package-root environment variable, so they cannot locate the scripts shipped with the packages. The pi refuter orchestrator therefore copies the self-contained `spanda-audit.py` (shipped in `claude/plugins/team/scripts/`) into the job folder's `scripts/`, and the pi consultant runs it from there. Claude agents keep their `${CLAUDE_PLUGIN_ROOT}` paths and do not use `scripts/`.
