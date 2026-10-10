# Job-file contract

This document is the authoring spec for the transactional job-file protocol used by the conductor and refuter plugins on the Claude and pi harnesses.

Every non-main agent is a transaction: it reads one input file, does the work, writes one result file, and replies with one line. Main is the only agent that talks to the human. On pi, the orchestrator (`pi/conductor/orchestrator.md`, `pi/refuter/orchestrator.md`) plays the role of main.

Workers take their input from files because subagents do not get `TaskGet` or `TaskUpdate` (Claude Code 2.1.283). The task list remains main's own status board and is never a worker's input.

## Agents cannot read this document

Installed plugins cannot read the repository's `docs/` folder at runtime. Each agent prompt therefore carries its own part of this contract: its row of the role table, the schema of the file it reads, the schema of the file it writes, the dispatch grammar, and the reply grammar. When this document changes, every agent prompt that embeds the changed part changes with it.

## Locations

| Plugin | Job root | Replaces |
|---|---|---|
| conductor | `.claude/conductor/jobs/` | worker dossiers held in task descriptions |
| refuter | `.claude/refuter/jobs/` | the refuter's former single plan file |

Each active job has its folder `.claude/<plugin>/jobs/<job-id>/`. The refuter folder mirrors the conductor shape so that one set of schemas and one set of agent-prompt fragments serves both plugins. In the refuter plugin, the job folder's `plan.md` replaces the refuter's former single plan file, which is no longer written.

`.claude/conductor/environment.md` is user-owned, lives outside `jobs/`, and is unchanged by this contract. Workers read it on demand for OS, editor, and toolchain facts. The job lifecycle never creates, edits, or deletes it.

`jobs/` is ignored by git through the repository's root `.gitignore`.

### Folder layout

```text
.claude/<plugin>/jobs/<job-id>/
  request.md               # main: preamble and the human's goal, written at job start
  plan.md                  # planning / architect: one anchored section per phase
  research.md              # conductor planning: research questions, one anchored section each
  research.result.md       # conductor research: answers, one anchored section per question
  scout.md                 # refuter main or architect: reconnaissance questions
  scout.result.md          # refuter scout: the map
  <phase-id>.result.md     # implement / developer: one file per phase
  review.md                # code-review / tester: verdict per phase
  issues.md                # code-review / tester: fixes a fix pass must make
  opinion.md               # refuter expert: per-claim risk
  skills/<name>.md         # main: copied SKILL.md text for workers
  scripts/<script>         # pi only: pi orchestrator's copies of the scripts workers run
.claude/<plugin>/jobs/archive/<YYYY-MM-DD>-<slug>/   # ended or closed jobs
```

A file appears only when its role runs. `<phase-id>` is a lowercase kebab-case slug that is unique within the job, for example `p1-job-file-contract`.

## Lifecycle

1. **Job start.** Main generates `<job-id>` as `YYYYMMDD-HHMM-<4 lowercase hex>`, independent of any session id, runs `mkdir -p .claude/<plugin>/jobs`, then a plain `mkdir` of the job folder, which fails if it exists; main then picks new hex, so sessions never share a folder. Main writes `request.md` and copies the needed skills into `skills/` (see Skill delivery); on pi, the refuter orchestrator also copies worker scripts into `scripts/` (see Script delivery).
2. **Work.** Main dispatches workers one line at a time. Each worker reads its input file, writes its output file, and replies.
3. **Job end.** After the final gate, main deletes every task it created and moves the job folder to `.claude/<plugin>/jobs/archive/<YYYY-MM-DD>-<slug>/`: the archive day, then a lowercase kebab-case summary of the initial prompt, five words at most, suffixed `-2`, `-3`, ... on collision.

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

`<file>` is the project-relative path of a file in the job folder, e.g. `Plan .claude/conductor/jobs/20260101-0900-a3f9/request.md#job.` That file's directory is the worker's job folder: every path it reads or writes (section, sibling results, skills, scripts) and every research or scout dispatch it sends resolves there, in the same full-path form. The worker reads that section of that file, plus any file the section names.

| Verb | Role | Example |
|---|---|---|
| `Plan` | conductor planning, refuter architect | `Plan .claude/conductor/jobs/<job-id>/request.md#job.` |
| `Research` | conductor research | `Research .claude/conductor/jobs/<job-id>/research.md#q1-plugin-cache-path.` |
| `Scout` | refuter scout | `Scout .claude/refuter/jobs/<job-id>/scout.md#job.` |
| `Implement` | conductor implement | `Implement .claude/conductor/jobs/<job-id>/plan.md#p1-job-file-contract.` |
| `Develop` | refuter developer | `Develop .claude/refuter/jobs/<job-id>/plan.md#p1-job-file-contract.` |
| `Fix` | conductor implement, refuter developer | `Fix .claude/<plugin>/jobs/<job-id>/issues.md#p1-job-file-contract.` |
| `Review` | conductor code-review | `Review .claude/conductor/jobs/<job-id>/plan.md#job.` |
| `Test` | refuter tester | `Test .claude/refuter/jobs/<job-id>/plan.md#p1-job-file-contract.` |
| `Consult` | refuter expert | `Consult .claude/refuter/jobs/<job-id>/review.md#p1-job-file-contract.` |

## Reply grammar

A worker's final message is exactly one line, one of:

```text
COMPLETE
BLOCKED: <reason>
```

`<reason>` is one sentence that names what is missing or contradictory. A worker that replies `BLOCKED: <reason>` still writes its output file with whatever it established. Any other reply text is a protocol violation, and main treats it as `BLOCKED`.

On pi, the engine kills a worker that issues the same tool call three times in a row, and replies for it `BLOCKED: <guard> — <reason>` followed by its last tool calls. No agent on either harness sets a turn cap. On pi, a drift nudge running inside each child steers a worker that repeats searches or results, or (for `implement` and `developer`) goes 40 calls without a Surface edit, with a `[drift]` message to take a concrete next step or write its result as `BLOCKED` with Gaps; it never kills.

**Rolling output.** Every worker keeps its output current while it works, so a stopped worker leaves its established findings on disk. It creates its output file early, or adds its own section to a shared file (`research.result.md`, the tester's `review.md`, `opinion.md`, each written under the rule in its schema below), and its first line is the marker:

```text
**Status:** in progress
```

After each confirmed finding or completed step, the worker updates the file with what is established and its next intended step, at milestones rather than after every tool call. Until the final write, a verdict-bearing file holds findings only: `review.md` has no `**Verdict:**` line, `plan.md` has no phase table or phase section to dispatch from, and `opinion.md` has no claim table. `issues.md` is written only in the final write, together with the verdicts, never while the marker stands. The final write replaces the file or section whole in its normal schema, without the marker.

**Salvage.** A `COMPLETE` reply whose output file or section still opens with the marker counts as `BLOCKED`. On `BLOCKED`, a guard kill or stopped worker, or a missing or garbled reply, main reads the output file if it exists and copies a marked file's established facts into the worker's input section as needing no re-reading, the one edit allowed to a section after its dispatch apart from appended `plan.md#job` **Revision** lines; with no file, it uses the guard's trace. It then corrects or narrows the section and spawns the worker fresh, never reading a marked file as a result, verdict, or plan. The refuter phase cycle's own handling wins: after expert `BLOCKED` main rules on the tester alone, and after tester `BLOCKED` it surfaces a marked `review.md` section as partial findings. The dispatching workers apply the same rule, planning to research sections and the architect to `scout.result.md`, copying the facts into a new `research.md` question section or `scout.md`.

`plan.md` has no Gaps section; a worker writing it that has something to flag replies `BLOCKED: <reason>` instead.

## Role table

The "Spawned by" column names the only agent that dispatches the role.

| Plugin | Harness | Role | Input file | Output file | Spawned by |
|---|---|---|---|---|---|
| conductor | Claude, pi | planning | `request.md#job` | `plan.md` | main |
| conductor | Claude, pi | research | `research.md#<question-id>` | `research.result.md#<question-id>` | planning |
| conductor | Claude, pi | implement | `plan.md#<phase-id>`; fix pass: `issues.md#<phase-id>` | `<phase-id>.result.md` | main |
| conductor | Claude, pi | code-review | `plan.md#job` plus every `<phase-id>.result.md` | `review.md`, plus `issues.md` when any phase fails | main |
| refuter | Claude, pi | architect | `request.md#job` | `plan.md` | main |
| refuter | Claude, pi | scout | `scout.md#job` | `scout.result.md` | main or architect |
| refuter | Claude, pi | developer | `plan.md#<phase-id>`; fix pass: `issues.md#<phase-id>` | `<phase-id>.result.md` | main |
| refuter | Claude, pi | tester | `plan.md#<phase-id>` plus `<phase-id>.result.md` | `review.md#<phase-id>`, plus `issues.md#<phase-id>` when the phase fails | main |
| refuter | Claude, pi | expert | `review.md#<phase-id>` (its disputed claims) | `opinion.md#<phase-id>` | main |

Research is spawned by planning, not main: planning writes `research.md`, spawns research, and reads `research.result.md` before it writes `plan.md`. Refuter architect may spawn scout the same way, through `scout.md`.

Conductor code-review holds `Write`: it writes `review.md` and, when a phase fails, `issues.md`.

## Review cycle

A fix pass is a fresh spawn that reads `issues.md`. No worker is resumed.

**Conductor.** Once every phase has a `COMPLETE` result, main applies the review-tier escalation, deletes any previous `issues.md`, and runs the effective **Review tier** (see plan.md). At `none`, main's own check passing with no escalation trigger leads to the final gate; otherwise the review tier rises. At `light` or `full`, main dispatches `Review plan.md#job.`; a `light` review whose `review.md` preamble carries `**Escalate:** full — <reason>` makes main append a `full` **Revision** line and dispatch Review again before acting on any verdict. Every verdict `PASS` leads to the final gate. On any `FAIL`, main dispatches `Fix issues.md#<phase-id>.` for each failing phase, a fresh implement that overwrites `<phase-id>.result.md`, then deletes `issues.md` and dispatches Review again. Fix rounds have no cap: the loop repeats until every verdict is `PASS`, and review's findings win over implement's claims. Only a `BLOCKED` review goes to the human with the findings from `review.md`.

**Refuter.** Each phase runs Develop, then Test, then Consult when `review.md#<phase-id>` lists disputed claims. Main rules on the verdict with the opinion, and on a remaining `FAIL` dispatches `Fix issues.md#<phase-id>.` to a fresh developer, followed by a fresh tester. Fix passes have no cap: the cycle repeats until main accepts the phase.

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

`plan.md` starts with a `job` index section, then one anchored section per phase. Each phase section is self-contained, because a worker reads only its own section. The job-level **Acceptance criteria** and **Verification commands** are conductor-only; the refuter's `job` section omits them because its gate runs per phase.

**Rationale** applies to both products: whoever writes `plan.md` (conductor planning, refuter architect, or main on a workflow tier where it writes the plan itself) records there, in two to four sentences, the decisions its planning reached: the workflow tier chosen, why that review tier (conductor only), the key decomposition or ordering decision, and the alternatives rejected with why. **Revision** lines are optional and main's alone: on each global re-plan or conductor review-tier escalation main appends one dated line to the end of the `job` section, never editing or deleting earlier **Rationale** or **Revision** text, so the original reasoning survives a resume.

**Review tier** is conductor-only: `none`, `light`, or `full`, with a one-clause reason, set by whoever writes `plan.md` (planning on the Full workflow tier, main on Direct Delegation and Lightweight); **Rationale** names why. An absent field means `full`.

| Review tier | When | What runs |
|---|---|---|
| `none` | Docs, prompts, config, copy, or mechanical single-surface edits where every acceptance item is checkable by one command | No review dispatch: main runs the **Verification commands** and `git diff --stat`/`--name-only` against **Diff base** from the repo root and reads the result files itself, the single sanctioned exception to verification belonging to specialists |
| `light` | Moderate code changes inside one surface, no public interface changed | `code-review` on changed hunks and one-hop callers, plus the **Verification commands** and every acceptance criterion; on Claude it is dispatched with `model: "sonnet"`, while pi's `subagent` takes no per-call model, so there `light` saves cost through narrower scope only |
| `full` | Public API, schema, migration, security, or concurrency changes, parallel phases sharing an interface, and every user-requested review (a review-only job, "review this branch"), whatever the field says | `code-review` reads every touched file whole and traces every caller |

Planning picks the lowest review tier whose "When" fits every phase; any phase meeting a `full` trigger makes the job `full`. **Escalation:** once every phase is `COMPLETE`, a result file with non-empty Gaps or an unconfirmed claim, a file in `git diff --name-only <Diff base>` outside every phase's **Surface**, or a failing verification command raises the review tier one step; a diff touching a public interface, schema, migration, security, or concurrency path raises it to `full`. **Review tier** stays as planned: main records each escalation as an appended `**Revision:** <YYYY-MM-DD> — review tier <light|full>: <trigger>` line, and the effective review tier is the latest such line, else **Review tier**. A fix round re-reviews at the effective review tier and never lowers it.

```markdown
# Plan

## job

**Goal:** <the job goal>

**Rationale:** <workflow tier chosen, why that review tier, the key decomposition or ordering decision, and the alternatives rejected with why>

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
- `.claude/<plugin>/jobs/<job-id>/skills/<name>.md`

**Research:** <dated facts from research or scout, each with its source, or None.>
```

### `<phase-id>.result.md`

Implement or developer writes this file. A fix pass overwrites it with the full current state, not a delta.

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
- <unmet criterion, dossier error, or assumption made; or None.>
```

### review.md

Conductor code-review writes one section per phase plus a `job` section, and, only at `light` when the diff meets a `full` trigger, one `**Escalate:** full — <reason>` line in the preamble. Refuter tester writes one section per phase; experts of other phases may read the file meanwhile, so the tester `Write`s it headed `# Review` only when it is absent, otherwise changes only its own section with `Edit`, never `Write`s it whole, and re-reads the file immediately before every `Edit`.

```markdown
# Review

## <phase-id>

**Verdict:** <PASS | FAIL>

**Checked:**
- `<command or file read>`: <what it showed>

**Disputed claims:**
- <claim from the result file that the reviewer could not confirm, or None.>
```

### issues.md

The reviewer writes this file only when a phase fails, and only in its final write, together with the verdicts. A fix pass reads `issues.md` cold, with no memory of the earlier pass, so each section repeats everything the fixer needs and points back to its plan section.

```markdown
# Issues

## <phase-id>

**Plan:** `plan.md#<phase-id>`

**Previous result:** `<phase-id>.result.md`

### <issue-id>
- **Location:** `<path>`, <symbol or section>
- **Problem:** <what is wrong, observed not inferred>
- **Evidence:** `<command>` -> <output that shows the problem>
- **Fix:** <added acceptance criterion the fix must satisfy>
```

### research.md and research.result.md

`research.result.md` is shared by research workers running in parallel. Planning creates the file, holding only the heading `# Research results`, before it spawns research; workers never `Write` it whole. Each changes only its own `## <question-id>` section with `Edit`, re-reads the file immediately before every `Edit`, re-appends its section if it went missing, and never changes another section. **Gaps** is present only when the worker is blocked.

```markdown
# Research

## <question-id>

**Question:** <one question>

**Why:** <the planning decision it settles>
```

```markdown
# Research results

## <question-id>

**Answer:** <direct answer>

**Sources:**
- <URL or library id>, retrieved <YYYY-MM-DD>

**Confidence:** <high | medium | low>

**Gaps:** <what remains unresolved; only when blocked>
```

### scout.md and scout.result.md

```markdown
# Scout

## job

**Questions:**
- <codebase or web question>
```

```markdown
# Scout result

## Map
- `<path>`: <what it holds, key symbols, callers>

## Facts
- <dated web fact, with source>

## Gaps
- <question not answered, or None.>
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

**Rejected: absolute SKILL.md paths in plan.md.** In this option, main resolves absolute paths with `Glob` and writes them into `plan.md`. It is rejected for three reasons. `${CLAUDE_PLUGIN_ROOT}` does not expand in a file read at runtime. The cache path `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` changes with every plugin update and differs under `--plugin-dir` or `CLAUDE_CODE_PLUGIN_CACHE_DIR`. Every worker read outside the working directory triggers a permission prompt that no human is watching.

**Skills on pi.** The pi orchestrator's *Conductor runtime* block lists the skill roots, taken from pi core's `pi.skills` entries, which point at `claude/plugins/*/skills`. The orchestrator copies `<skill root>/<name>/SKILL.md` to the job folder's `skills/<name>.md`, the same shape as on Claude.

## Script delivery (pi only)

pi workers receive no package-root environment variable, so they cannot locate the scripts shipped with the packages. The pi refuter orchestrator therefore copies the self-contained `spanda-audit.py` into the job folder's `scripts/`, and the pi expert runs it from there. Claude agents keep their `${CLAUDE_PLUGIN_ROOT}` paths and do not use `scripts/`.
