---
name: job-lifecycle
description: Orchestrator job lifecycle - Job end note and archive, Resume and Archive on request, worker skill copy. Load when your prompt's Job end, Resume, Archive or Skills trigger applies.
---

# Job Lifecycle

`<orchestrator>` is `conductor` or `refuter`, as your prompt names it. `<job>` = `.claude/<orchestrator>/jobs/<job-id>`, and `jobs/` below is `.claude/<orchestrator>/jobs/`. Your prompt owns each procedure's timing and the memory save; this skill holds the steps.

## Job end

1. Name the record `<name>` = `<YYYY-MM-DD>-<slug>`, slug summarizing the initial prompt in ≤5 kebab-case words, suffixed `-2`, `-3`, … while `jobs/archive/<name>.md` or `jobs/local/<name>/` exists or `git log --all --format=%h -1 -- .claude/<orchestrator>/jobs/archive/<name>.md` prints anything. That check is read-only (for the refuter, its only git use); you never stage, commit, or push.
2. Write the OKF job note `jobs/archive/<name>.md`, 20 to 60 lines distilled from `request.md`, `plan.md#job`, `review.md` and the result files' `**Decisions:**`, never a result file copied wholesale; each section `None.` when empty; `outcome` is `complete` when the job's **Goal** is met, even with plan phases unrun, else `incomplete`:
   ```markdown
   ---
   type: job
   title: <slug words in sentence case>
   description: <one sentence: what the job changed or decided>
   job_id: <job-id>
   archived: <YYYY-MM-DD>
   outcome: <complete | incomplete>
   tags: [job, <orchestrator>]
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
   <memory notes this job wrote or updated>

   ## Artifacts
   <files retained under references/>
   ```
3. Insert `* [<title>](<name>.md) - <description>` as the first entry under `# Jobs` in `jobs/archive/index.md`, creating it when absent with frontmatter `okf_version: "0.2"` only, then `# Jobs`.
4. `mkdir -p .claude/<orchestrator>/jobs/local && mv <job> .claude/<orchestrator>/jobs/local/<name>`, then tell the human to commit `jobs/archive/` and memory in their own commit, apart from project changes, before removing the worktree.

## Resume on request

Only when asked: list active `jobs/*/` (not `archive/`, `local/`) by job-id and **Goal**, adopt the pick, continue from the first phase without a `COMPLETE` result (`**Status:** in progress` is salvage), and create tasks for the rest.

## Archive on request

Append `**Closed incomplete:** <YYYY-MM-DD>` to the set-aside job's `request.md` preamble; once memory is saved as your prompt's trigger orders, close it per **Job end** with `outcome: incomplete`.

## Skill copy

The conductor's procedure; the refuter follows its own **Skill delivery**. Workers have no skill tool or preload; they read `<job>/skills/<name>.md`, filled by one byte-exact `cp -n <source> <target>` per `SKILL.md`, never `Read`/`read` then `Write`/`write` (pays the skill in tokens, turns CRLF into LF). Copy each once per job, never over an existing file. Unlocatable skill → say so once, drop it from the phase's **Skills**. Source:
- Claude Code: `${CLAUDE_PLUGIN_ROOT}/../<plugin>/skills/<name>/SKILL.md`, else the `Glob` match of `${CLAUDE_PLUGIN_ROOT}/../../<plugin>/*/skills/<name>/SKILL.md`; language skills (`rust`, `typescript`, `vue3`, `bevy`, `blender`) live in the same-named plugin, `git-diff` and `sequential-thinking` in `baton`.
- pi: `<skill root>/<name>/SKILL.md` for the skill root under *Conductor runtime* that holds it; `git-diff` and `sequential-thinking` in the baton skill root.
