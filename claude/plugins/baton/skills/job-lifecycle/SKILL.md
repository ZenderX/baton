---
name: job-lifecycle
description: Orchestrator job lifecycle - Job end note and archive, Resume and Archive on request, worker skill copy, environment pre-check, developer resume, verification waits and gate reuse. Load when your prompt's Job end, Resume, Archive, Skills, Environment pre-check, Developer resume or Verification waits trigger applies.
---

# Job Lifecycle

`<orchestrator>` is `conductor` or `refuter`, as your prompt names it. `<job>` = `.baton/<orchestrator>/jobs/<job-id>`, and `jobs/` below is `.baton/<orchestrator>/jobs/`. Your prompt owns each procedure's timing and the memory save; this skill holds the steps.

## Job end

1. Name the record `<name>` = `<YYYY-MM-DD>-<slug>`, slug summarizing the initial prompt in ≤5 kebab-case words, suffixed `-2`, `-3`, … while `jobs/archive/<name>.md` or `jobs/local/<name>/` exists or `git log --all --format=%h -1 -- .baton/<orchestrator>/jobs/archive/<name>.md` prints anything. That check is read-only (for the refuter, its only git use); you never stage, commit, or push.
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
4. `mkdir -p .baton/<orchestrator>/jobs/local && mv <job> .baton/<orchestrator>/jobs/local/<name>`, then tell the human to commit `jobs/archive/` and memory in their own commit, apart from project changes, before removing the worktree. Your final report carries ready-to-paste commit messages for the human, derived from `plan.md#job` **Goal** and the phases' result files, never from `git diff`, `git status` or a file dump:
   - Project commit, only when the job changed project files: a conventional-commit subject of at most ~72 chars (`feat: …`, `fix: …` or `chore: …`, a lowercase imperative verb after the prefix), optionally followed by at most 3 short `-` bullets.
   - Archive-and-memory commit: one line, `chore(memory): <what this job recorded>`.
   - Both stay neutral, describing only the public change: no job ids, people, local paths, session URLs or attribution trailers.

## Resume on request

Only when asked: list active `jobs/*/` (not `archive/`, `local/`) by job-id and **Goal**, adopt the pick, continue from the first phase without a `COMPLETE` result (`**Status:** in progress` is salvage), and create tasks for the rest.

## Archive on request

Append `**Closed incomplete:** <YYYY-MM-DD>` to the set-aside job's `request.md` preamble; once memory is saved as your prompt's trigger orders, close it per **Job end** with `outcome: incomplete`.

## Environment pre-check

For each phase your prompt's trigger names (its acceptance runs a built binary or app end to end), name the output it rebuilds or runs, from its **Surface**, **Context** or acceptance commands. Create one `Decision: free <output>` task `in_progress` whose `description` asks the human to stop whatever holds that output (a running instance of the program, a debugger, a viewer) before that phase starts, and ask it in the message carrying the first dispatches, so the human acts while earlier phases run. `completed` once the human confirms, `deleted` if the phase is dropped. The phase still dispatches when its dependencies complete; a still-held output stops its developer `BLOCKED` at once, before any gate. Then ask again under the same task, and once the human frees it, append that confirmation to the phase's **Context** and resume the developer per **Developer resume**.

## Developer resume

Claude Code only: pi's `subagent` has no resume, so a pi orchestrator spawns fresh.

1. After a developer's `BLOCKED` reply, write or replace its `agents.md` row in one `Edit` or `Write`, other rows kept: `| developer | <dispatched file>#<anchor> | <agent id> | <model it ran on> | kept |`, under `# Agents` and the header `| Role | Anchor | Agent ID | Model | State |` (create the file when absent).
2. A correction that only widens or clarifies the section resumes: a settled fact added to **Context** or **Unknowns**, a test file the phase's own behaviour change broke added to **Surface**, a freed output (**Environment pre-check**). A redesign (new goal, approach or phase split) does not.
3. Resume: correct the section, then send the same `Implement` or `Fix` line by `SendMessage` to the row's agent ID. The run keeps its model, effort, built state and result file, then replies as a fresh run would; route its reply as usual.
4. Set the row's `State` to `expired` on a redesign, a `SendMessage` error or cancelled notice (then spawn fresh), on any fresh spawn for that anchor, and once the phase passes review.

## Verification waits and gate reuse

For the commands an orchestrator runs itself (the conductor's tier-`none` check). Wait in chunks of at most 170 s, as Claude Code moves a longer foreground `Bash` call to the background at 180 s and answers it late, and a call past 5 minutes outlives the prompt cache and forces a full-price prefix rewrite: a command that may exceed 170 s starts in the background — `nohup sh -c '<cmd>; echo exit=$?' > <log> 2>&1 &`, noting the PID — and is awaited by foreground calls of `timeout 170 tail --pid=<pid> -f /dev/null` until one returns 0 (124: still running), then read the log; any other command runs in the foreground with a `timeout` of at most 170 s (Claude Code `Bash`: 170000 ms; pi `bash`: 170, in seconds). No `sleep`, no single blocking call over 170 s, and never end the turn with the job running.

Before running a **Verification commands** entry, compute the read-only state hash `{ git --no-optional-locks rev-parse HEAD; git --no-optional-locks diff HEAD --binary; git --no-optional-locks ls-files -o --exclude-standard -z | xargs -0 git --no-optional-locks hash-object --; git --no-optional-locks ls-files -o --exclude-standard; } | git --no-optional-locks hash-object --stdin` (it covers HEAD, tracked changes, and untracked non-ignored files, writes nothing, and its `LF will be replaced by CRLF` warnings are harmless). A result file's Verification row for the same command whose Result opens `state <hash>:` and records a pass covers the current state only when the hash is the same: cite that row instead of running the command.

## Skill copy

The conductor's procedure; the refuter follows its own **Skill delivery**. Workers have no skill tool or preload; they read `<job>/skills/<name>.md`, filled by one byte-exact `cp -n <source> <target>` per `SKILL.md`, never `Read`/`read` then `Write`/`write` (pays the skill in tokens, turns CRLF into LF). Copy each once per job, never over an existing file. Unlocatable skill → say so once, drop it from the phase's **Skills**. Source:
- Claude Code: `${CLAUDE_PLUGIN_ROOT}/../<plugin>/skills/<name>/SKILL.md`, else the `Glob` match of `${CLAUDE_PLUGIN_ROOT}/../../<plugin>/*/skills/<name>/SKILL.md`; language skills (`rust`, `typescript`, `vue3`, `bevy`, `blender`) live in the same-named plugin, `git-diff`, `planning-poker` and `sequential-thinking` in `baton`.
- pi: `<skill root>/<name>/SKILL.md` for the skill root under *Conductor runtime* that holds it; `git-diff`, `planning-poker` and `sequential-thinking` in the baton skill root.
