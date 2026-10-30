# Changelog

## Unreleased

- Changed: environment pre-check. Before the first phase dispatch, the conductor and refuter (Claude Code and pi) run the new `job-lifecycle` **Environment pre-check** for every phase whose acceptance runs a built binary or app end to end: a `Decision: free <output>` task asks the human, while earlier phases run, to stop whatever holds that output. A developer or reviewer that finds an output file locked or busy replies `BLOCKED` at once, naming the file and symptom, before running any gate
- Changed: gate-result reuse. A passing build or test gate is keyed to a tree hash over tracked and untracked files (`GIT_INDEX_FILE=<tmp> git add -A && GIT_INDEX_FILE=<tmp> git write-tree`), recorded as a `tree <hash>:` prefix on its result-file Verification row. A recorded pass covers the current tree when the hash matches or the changed files are ones the gate neither builds nor tests (docs, job files): the developer skips the gate (no source changed, a docs-only fix) and cites the row, and the reviewer, its `Recheck`, and the conductor's tier-`none` check cite it instead of re-running (Claude Code and pi)
- Changed: the wait rule. "Build and test in the foreground, never `run_in_background`" and the ~4 min `nohup` / `timeout 110 tail --pid` exception are replaced by one rule in the developer and reviewer (Claude Code and pi) and the conductor's tier-`none` check (`job-lifecycle` **Verification waits and gate reuse**): wait in chunks of at most 270 s, since one longer blocking call outlives the 5-minute prompt cache. A command that may exceed ~4.5 min starts in the background with `nohup` and is awaited by foreground `timeout 270 tail --pid=<pid> -f /dev/null` calls; no `sleep`, no single blocking call over 270 s, and no turn ends with the job running
- Changed: a `BLOCKED` developer is resumed on Claude Code. When the section correction only widens or clarifies it (a settled fact, a freed output, or a test file its own behaviour change broke), the conductor and refuter send the same `Implement` or `Fix` line by `SendMessage` to the kept developer, recorded in an `agents.md` developer row, instead of spawning fresh (`job-lifecycle` **Developer resume**); the developer re-reads only its section and keeps its built state. A redesign still spawns fresh. The architect's **Surface** now also lists any test file outside the phase's paths that its own behaviour change breaks. On pi, which has no resume, the developer prompt and the skill say so
- Changed: on Claude Code the conductor and refuter keep an `Answer` analyst's agent ID, and when the human then asks for the change on the same subject, the orient `Analyze` continues that analyst by `SendMessage`. The analyst reuses its verified findings, re-verifies files that may have changed, and writes `analyst.result.md#job` as usual. An error falls back to a fresh spawn. The pi analyst prompt notes this is not wired on pi
- Changed: reviewer routing. The conductor's whole-job `Review` passes `model: "opus"` at effective tier `light` and none at `full`, where the reviewer runs on its frontmatter `fable`; an `**Escalate: full**` re-dispatch is a fresh spawn with no `model:`. `agents.md` gains a `Model` column naming the model each kept worker ran on, so review cost can be compared per model. The whole-job `full` reviewer reads per-phase diff bundles (new `git-diff` step 5, the diff against the diff base over one phase's **Surface** plus its untracked files) and opens full files only behind hunks touching a public interface, lifetimes/GC, concurrency, or security, or outside every **Surface**. The refuter's single-phase review stays on `fable` with full files; pi documents the model routing as Claude Code only
- Changed: the architect (Claude Code and pi) gains a **Plan for parallelism** rule: shared-doc edits (`docs/`, the changelog, READMEs) go into one final docs phase depending on the code phases, and phases sharing a build output dir get a table edge or each a private build dir named in **Context** (e.g. a per-phase `CARGO_TARGET_DIR`). Plans never rely on `isolation: worktree`, which branches from the default branch and loses uncommitted starting state (the pi architect notes that `subagent` has no worktree isolation, so parallel phases share one working tree). The conductor and refuter fan out phases sharing a build output dir only when each has a private build dir
- Changed: the conductor and refuter (Claude Code and pi) state that phases forming a dependent chain are never fanned out and are dispatched one at a time
- Changed: the developer, and the reviewer in single-phase mode, read only their own sections: they find a section's heading and the next same-or-higher heading with `Grep -n` (pi: `grep`) and read that range with `offset`/`limit`, never the whole `plan.md`, `request.md`, `issues.md` or `analyst.result.md`
- Changed: the `baton` restore-crlf PostToolUse hook matcher now also covers `PowerShell` tool calls, matching the pi port
- Changed: the developer and reviewer leave line endings to the CRLF-restore hook (on pi, the core `restore-crlf` extension) and never count CRs or rewrite a file for its endings; the `Edit`-only rule stays
- Changed: an opt-in per-phase `**Effort:** <low | medium>` line, set by the architect after `**Model:**` only for mechanical phases with the reason in **Rationale**. The conductor and refuter pass it as `effort:` on that phase's `Implement` and `Fix` only (Claude Code v2.1.292+) and gate-check its value; with no line no `effort:` is passed and the user's default stands. No worker gains an `effort:` frontmatter key. A resumed run keeps its first run's model and effort. On pi the line is documentation only, like `**Model:**`
- Changed: the conductor and refuter prompts (Claude Code and pi) close and archive a job through Job end in the same turn that reports its answer or outcome, so at turn end no job folder stays in `jobs/` unless a dispatch result is pending or a `Decision` awaits the human. The conductor's "the answer given" turn-end condition now names the **answer** path, which has no job; the refuter's Job end fires after step 4 accepts the last phase instead of after an undefined final gate; and the `job-lifecycle` skill records `outcome: complete` when the job's **Goal** is met, even with plan phases unrun, else `incomplete`
- Changed: the four orchestrator prompts (conductor and refuter, Claude Code and pi) are trimmed for redundancy with no rule changed, and the three triage-rework leftovers are fixed: the refuters read `.claude/environment.md` at job start, the architect names the **Verification commands** as run once by the job's single verifier per `docs/job-files.md` **Verify once**, and the pi refuter's memory-index citation names the `Memory index` entry of the `## Conductor runtime` block. The Job end, Resume, Archive and skill-copy procedures moved out of the always-loaded prompts into the new on-demand `job-lifecycle` skill, each replaced by a one-line trigger
- Changed: the conductor and refuter triage each request before creating a job, by mechanical criteria, onto one of three paths. **answer** covers a question, review or audit with no requested change: the orchestrator reads at most 3 named files within a line budget, or dispatches one analyst with the new inline `Answer <question>` verb, and creates no job folder. **direct** covers at most two named files with a stated edit and no unknowns: the orchestrator writes `request.md` and a one-phase `plan.md` itself and dispatches one developer; the conductor verifies by the `none` check, converting to full on failure, and the refuter keeps its single-phase review and consult. **full** is the existing pipeline, which now exits after `Analyze` without `Plan` when the analyst replies `change no`. Result files split **Gaps** (doubts about the worker's own work, the only thing that escalates) from **Notes** (out-of-scope observations, report-only); analyst Gaps are no longer copied into `request.md` **Constraints**, which name each binding memory rule in one clause. Verification is paid for once: developers record each acceptance command's output, and the reviewer and the tier-`none` check re-run a command only when its recorded output is missing, contradicted, or covers files a later phase touched. Handoffs are leaner: plans have per-tier size limits, phase **Context** cites `analyst.result.md#<surface-slug>` anchors plus at most 5 copied facts, and `sequential-thinking` is copied only when `Plan` is dispatched. Worker-to-worker resume is not wired, since workers have no `SendMessage` and pi spawns `--no-session` processes; the architect answers from the orient map before spawning an analyst. All four orchestrator prompts are smaller despite the added triage text
- Changed: the job-file handoff protocol carries located facts between workers, with the dispatch kept a one-line pointer. Analyst findings and plan **Context** cite path plus heading or symbol anchors, rosters, and line-ending rules; plan **Surface** is a backticked path list; developers and reviewers read `request.md#job` **Constraints**; developers read each dependency's result `## Interfaces` and `**Decisions:**`; results gain anchored **Changed files** lines and a required **Decisions** field; whole-job reviewers read full phase sections; every worker reply is one line, `COMPLETE — <per-role routing summary>` or `BLOCKED: <reason>`; orchestrators route on the summary and write any fact the next worker needs into its input file before dispatch
- Added: the vendored `sequential-thinking` skill is back in `baton` (thedotmack/sequential-thinking-skill @ `d0fd5d4`, MIT, byte-identical to its last vendored state) with its `.think_state.json` ignore rule. The conductor and refuter copy it to `skills/sequential-thinking.md` before the first `Plan` dispatch; the architect follows its thought protocol inline when decomposing and records only decisions in **Rationale**; refuter main uses it for its own planning on its Lightweight and Full tiers; pi bash-capable workers carry a guard against running its `scripts/think.ts`, which no agent runs. The baton and team plugin descriptions list the skill again, and `README.md` credits it under License
- Changed: the `okf-memory-migrate` skill is renamed `okf-memory-cleanup` (`/baton:okf-memory-cleanup`); besides migrating older memory to the OKF v0.2 vault it distils raw archived job folders into the job bundle and verifies that bundle. The baton plugin and marketplace descriptions name the new skill
- Changed: job archives are an OKF v0.2 job bundle at `.claude/<product>/jobs/archive/`: one `type: job` note `<YYYY-MM-DD>-<slug>.md` per ended job, a root `index.md` listing them newest first, and a `references/` folder for retained artifacts. Raw job folders move to `.claude/<product>/jobs/local/` and are never tracked; only the notes sync through git
- Changed: memory notes are valid in both OKF v0.2 and Claude Code's native memory format: each note keeps the top-level `type` and `title` and also carries `name` (the file slug) and a trailing `metadata.type` equal to `type`. `MEMORY.md` frontmatter gains a one-line `description`. Frontmatter values containing ` #` are double-quoted, since YAML reads an unquoted ` #` as a comment. The `okf-memory` skill states the rule; `okf-memory-cleanup` keeps native `name`/`metadata.type` when converting instead of dropping them and verifies them with new `NAME`, `META` and `HASH` checks

## v5.0.2 — 2026-10-22

- Add rules to prevent nested orchestrators in conductor and refuter agents

## v5.0.1 — 2026-10-16

- Use model aliases in agent frontmatter
- Copy job skills only once per job with a byte-exact cp

## v5.0.0 — 2026-10-11

- Add root pi package manifest for git installs
- Move plugin marketplace to repo root
- Add CI and release workflows
- Update model versions for various agents in the conductor and refuter plugins
- Add job files documentation
- Rewrite README
- Ignore local agent state and reword drift comment
- Refactor refuter agents and orchestrator for improved workflow
- Refactor memory handling and update documentation for OKF v0.2 compliance
- Refactor documentation and agent protocols to streamline sequential thinking usage
- feat: add feedback task list accuracy guideline and update planning workflow descriptions
- feat: update statusline to remove input token display in credit mode and adjust related documentation
- Enhance conductor and refuter workflows with tiered review processes
- feat: update statusline design to "8a: Identity line, then the 6a grid" and fix gauge() for non-integer usage percent
- feat: update statusline design to "6a: Thin bars, cache in the grid" and enhance gauge functionality
- feat: implement CRLF restoration functionality and add harness tests
- Enhance Baton Plugin and Documentation
- Refactor documentation and code to integrate context7 MCP server, update sequential thinking references, and enhance job file structure. Adjust installation instructions, agent workflows, and planning processes to clarify roles and responsibilities. Remove unused sequential thinking tool from MCP configuration and ensure consistent use of thought protocols across agents. Update scripts to exclude unnecessary files and improve global sync functionality.
- Refactor agent documentation and memory handling
- feat: update model version to claude-sonnet-5-5 in memory and research agents
- feat: add documentation for MCP instructions reaching ungranted agents and update tool allowlists in main agents
- feat: enhance MEMORY documentation and refine agent memory handling rules
- feat: add cwd drift misroutes memory writes documentation
- Refactor job handling to use job folders
- Refactor memory handling and documentation across agents
- refactor: clean up documentation and remove obsolete subagent allowlist reference
- fix: improve command formatting in formatToolCall function for better output readability
- feat: implement no-retry strategy for transient errors and update task store handling
- docs: add karpathy's operating rules for builder and implement agents
- bring back karpathy's rules
- feat(drift): implement drift detection and nudge mechanism
- Add local no queue timeouts feature; update statusline and subagent live handling for decode rates
- Refactor footer line handling to support multiple task rows; update related documentation and tests
- Restore pi task list and worker guards; add rolling result files
- Remove settings.json configuration file
- Refactor MCP server management and implement double-load guard
- chore: update models and efforts for various agents in conductor and refuter plugins
- Refactor refuter agents and orchestrator workflow
- Refactor agent descriptions and enhance documentation
- fix: swap model types between planning, auditor, builder, main, and refuter agents
- feat: add 'conductor:memory' to tools list for enhanced agent capabilities
- Refactor Triage and Orchestrator Documentation
- feat: add statusline extension for enhanced footer display
- Refactor TypeScript configuration and update global scripts
- Enhance statusline functionality and introduce footer-line registry
- fix: update model references for auditor and refuter agents
- optimization
- Refactor sequential thinking integration across agents and documentation
- feat: Introduce new agents for enhanced workflow management
- Refactor sequential-thinking tool naming and update related documentation
- feat(hooks): implement PostToolUse hook for TaskCreate and TaskUpdate with task echo functionality
- feat(conductor): add new subagents for enhanced code analysis and review
- fix(statusline): adjust formatting for right-aligned figures and improve separator handling
- feat: enhance agent memory documentation and implement live subagent tracking for performance metrics
- feat(statusline): implement live speedometer for streaming messages and update footer refresh rate
- feat: add provider prefix check for lmstudio in before_provider_request hook
- feat: add documentation for StrictMode pipeline behavior and PSCustomObject property checks
- fix: update tool IDs to use plugin-scoped naming convention across agent files
- feat(statusline): enhance footer with live context window and cost metrics
- feat: Update agent memory and skills documentation; enforce scope-first skill loading
- feat: Add early returns section to TypeScript coding standards
- fix scripts, pi extension and package.json for new structure
- move claude marketplace and plugin to it's own claude folder
- feat: Update model to 'opus' and set effort level to medium in main agent configuration
- feat: Update environment.md references and clarify subagent reading behavior
- Refactor MCP integration and tool registration across pi agents
- feat: Add guidance for clearing task list at job end to prevent stale tasks
- tr
- feat: Rename project to "the-conductor" and update related documentation and plugin metadata
- feat: Update agent memory documentation and implement new reporting guidelines
- feat: Enhance agent memory and dialect normalization
- feat: add pre-delegation gate to Subagent Brief Protocol for enhanced task delegation accuracy
- feat: Add sequential thinking tool and update agent documentation
- feat(agents): update models for implement, main, and planning subagents
- feat(agents): update models and effort levels for implement and planning subagents
- feat(conductor): introduce spawn allow-list for subagents
- feat(settings): add initial settings.json for environment configuration
- feat(conductor): implement Task tools and update documentation for setup
- feat: Implement Conductor orchestrator mode with detailed workflow management
- fix(docs): update file paths in main and planning agent documentation
- feat(main): add mcp__claude_design__read_file to tools list
- feat(code-review): enforce English language requirement for comments in reviews

## v4.1.0 — 2026-08-21

- feat(bevy): update documentation for Bevy 0.19.1 conventions, API changes, and plugin architecture
- feat(bevy): update Bevy version in descriptions to 0.19.1 across marketplace and plugin files
- feat(statusline): update README and script for improved token handling and cache management

## v4.0.0 — 2026-08-16

- feat(statusline): enhance statusline script with improved color coding and countdown display docs: add detailed documentation for statusline plumbing and usage
- feat(statusline): add statusline plugin with hooks and configuration for enhanced user experience
- refactor(documentation): add environment details for the Skills marketplace
- Remove obsolete settings file
- refactor(memory): update memory documentation and structure for clarity and accuracy
- refactor(documentation): enhance agent documentation with brief contracts and schema details
- refactor(conductor): update environment injection protocol to ensure project environment is always first in subagent briefs
- refactor(environment): update environment file description for clarity and accuracy refactor(planning): change model from opus to fable for planning subagent
- refactor(memory): enhance memory linter checks and update documentation for vault management
- refactor(environment): add conductor environment file and update main agent documentation
- refactor(planning): enhance phase dossier structure for implement subagent and clarify context handling
- refactor(main): clarify task routing and planning requirements in conductor agent documentation
- refactor(types): add guidelines for parameter destructuring in TypeScript coding standards
- refactor(implement): update skills list to include TypeScript and enhance clarity in main agent tools
- refactor(agents): update model to 'opus' for implement, planning, and main agents
- refactor(main): enhance clarity and structure in conductor agent documentation
- refactor(settings): remove fetch and mv commands from denied permissions
- refactor(main): remove redundant line in engineering rules for clarity
- refactor(memory): enhance memory management with targeted pass and authority clarifications
- feat(memory): add memory agent and update memory skills
- refactor: remove .mcp.json configuration file and associated context
- refactor: add autoUpdate property to skills-marketplace configuration
- refactor: remove sequential-thinking skill from marketplace and update related tools
- Refactor planning and research agents; remove sequential-thinking skill
- refactor: update memory documentation for clarity, add dirty flags, and correct phantom citations
- refactor: update memory documentation for clarity and accuracy, add dirty flags for related changes
- refactor: update main agent tools to remove redundant skill references
- Refactor sequential thinking integration: remove MCP server dependency, streamline agent tools, and enhance documentation
- refactor: enhance memory migration logic and clarify documentation
- feat: implement stray location boundary clamp and enhance memory linting process
- Refactor memory-review skill documentation for clarity and accuracy
- chore: update memory management and dirty flag handling; enhance stray note migration process
- Enhance PowerShell Support and Update Agent Rules
- Refactor operating standards and improve agent configurations
- feat: add memory-write, obsidian-links, and operating-standards skills
- Refactor memory management and dirty flag handling across plugins
- Refactor planning and research subagent documentation; enhance memory discipline and linting scripts
- Refactor and update documentation for plugin architecture and memory management
- Update memory subagent and conductor scoped identifiers
- Remove obsolete Vue 3 skill documentation and build scripts; introduce global cleanup and sync scripts for improved plugin management
- Refactor README to clarify Claude Code agent ecosystem and streamline deployment instructions
- Add Rust, TypeScript, and Vue 3 coding standards plugins
- Add new research notes and promote existing documentation for clarity and accuracy
- Enhance agent memory documentation and fix path resolution issues

## v3.0.0 — 2026-07-15

- Enhance sync-global.ps1 with ConvertTo-Hashtable function for improved JSON handling
- Enhance memory management and documentation: - Add colorGroups configuration to graph.json for dynamic topic colorization. - Update MEMORY.md files across various subagents to reflect recent changes and additions. - Introduce new notes for handling untrusted code briefs and strict mode JSON property crashes. - Regenerate graph.json colorGroups in memory-lint.ps1 for improved topic synchronization. - Remove obsolete task plan file.
- Add documentation for filesystem delete operations and clarify git state rules
- Update metadata and improve idempotency in MCP server sync process
- Enhance task plan lifecycle management in conductor and planning subagent documentation
- Refactor memory management and topic taxonomy
- Update documentation and metadata across multiple files: add topic hubs, refine tags, and adjust updated dates
- Add settings.json sync functionality to sync-global.ps1 and document edge cases in MEMORY.md
- Update memory documentation and git hygiene rules: add PowerShell tooling guidelines, remove git write blocking hook, and revise git hygiene rules to reflect denied operations.
- Implement memory ecosystem additions: introduce memory-subagent for dirty propagation, add memory-write and obsidian-links skills, and update relevant documentation.
- Update agent documentation: add metadata.updated field to mechanics section across multiple subagents
- Refactor agent memory structure: remove obsolete conventions file, update MEMORY.md, and enhance documentation for conductor CLI usage
- Update memory index and documentation; add git write blocking hook and sync adjustments
- Add engineering and git hygiene rules; implement memory review skill and linting script

## v2.7.2 — 2026-06-27

- Remove obsolete agent documentation and instructions; delete planning and research subagent files, copilot instructions, and various coding standards for Rust, TypeScript, Bevy, and Blender integration.
- Change model from 'opus' to 'inherit' for improved orchestration consistency

## v2.7.1 — 2026-06-21

## v2.7.0 — 2026-06-21

- Refactor code structure for improved readability and maintainability
- Add conductor memory index and refine delegation principles for improved orchestration

## v2.6.1 — 2026-06-13

- Clarify conductor's action space by specifying read-only git commands and prohibiting staging modifications

## v2.6.0 — 2026-06-13

- Enhance operating boundaries and introduce anti-laziness mandates for the conductor agent

## v2.5.1 — 2026-06-13

## v2.5.0 — 2026-06-13

- Refactor MCP server commands to use npx directly
- Enhance web research guidelines and clarify roles for conductor and research subagents

## v2.4.0 — 2026-06-06

- Update agent models and enhance tool listings for improved functionality
- Update conductor and implement-subagent documentation to include new tools for file management
- Refactor agent documentation for clarity and update operational boundaries
- Update agent documentation for clarity and refine research findings handling
- Refactor agent documentation for clarity and update tool listings

## v2.3.1 — 2026-05-21

- Refactor code structure for improved readability and maintainability

## v2.3.0 — 2026-05-21

- Refactor code structure for improved readability and maintainability

## v2.2.0 — 2026-05-21

- Update code-review-subagent description for clarity and add operational modes
- Update agent tools to include additional functionalities for improved operations

## v2.1.1 — 2026-05-19

- Update sync script for improved path handling
- Update file paths in agent documentation to include .claude prefix for consistency

## v2.1.0 — 2026-05-17

- Update Copilot agents and instructions; add git-diff instructions
- Add conductor and subagent architecture with detailed instructions

## v2.0.0 — 2026-05-17

- Add SKILL.md files for Bevy, Blender, and Rust conventions; update sync script for clarity and functionality
- Refactor CLAUDE.md to clarify conductor role and streamline task routing sections
- Add coding rules and sync script for project assets

## v1.1.0 — 2026-05-15

## v1.0.0 — 2026-05-15

- Refactor agent architecture and documentation
- Add sync script for agent content between directories
- Enhance agent documentation with tool usage guidelines and sequential thinking strategies for improved clarity and effectiveness
- Refine conductor usage guidelines and remove unnecessary sections for clarity
- Enhance agent descriptions with notable figures' attributes for clarity and impact
- initial-commit

## v0.0.18 — 2026-04-24

- Add Claude Code agents, skills, MCP config, CLAUDE.md and README

## v0.0.17 — 2026-04-12

- Add instructions; update subagents, agents and instructions

## v0.0.16 — 2026-03-28

- Update conductor agent

## v0.0.15 — 2026-03-22

- Update implement and planning subagents and conductor agent

## v0.0.14 — 2026-03-15

- Update code-review subagent and conductor agent
- Update subagents, conductor agent and Rust instructions
- Update implement, planning and research subagents
- Update implement subagent and conductor agent

## v0.0.13 — 2026-03-10

- Update implement subagent and conductor agent
- Add research subagent; update subagents, agents and Copilot instructions
- Update code-review, implement and planning subagents
- Update code-review subagent and conductor agent
- Update code-review, implement and planning subagents and conductor agent
- Update conductor agent

## v0.0.12 — 2026-03-05

- Update conductor agent
- Update code-review, implement and planning subagents and conductor agent
- Add project instructions; update Copilot instructions
- Update code-review subagent
- Update subagents, agents, instructions and Copilot instructions

## v0.0.11 — 2026-02-17

- Update subagents, agents, instructions and Copilot instructions
- Update conductor agent
- Update code-review, implement and planning subagents and conductor agent
- Update planning subagent
- Update code-review, implement and planning subagents and conductor agent
- Update implement and planning subagents
- Update subagents and agents
- Update implement subagent
- Update code-review, implement and planning subagents and conductor agent
- Update planning subagent, agents and Copilot instructions
- Update implement subagent, Rust instructions and Copilot instructions
- Update implement subagent
- Update subagents, instructions and Copilot instructions

## v0.0.10 — 2025-12-28

- Update subagents, agents, instructions and Copilot instructions
- Update planning subagent, conductor agent and Rust instructions

## v0.0.9 — 2025-12-23

- Update conductor agent
- Update Copilot instructions; remove project instructions
- Update Copilot instructions
- Update Rust instructions
- Update implement subagent
- Update subagents, instructions and Copilot instructions
- Add implement and planning agents; update subagents and conductor agent
- Update subagents and agents; remove implement and planning agents

## v0.0.8 — 2025-12-11

- Update subagents, agents, instructions and Copilot instructions
- Update subagents, agents and instructions; remove project instructions
- Update subagents, agents, instructions and Copilot instructions
- Update Rust instructions
- Update conductor agent
- Update code-review and implement subagents and conductor agent
- Add project instructions; update implement subagent and conductor agent
- Update subagents, conductor agent, instructions and Copilot instructions

## v0.0.7 — 2025-11-26

- Add Rust instructions

## v0.0.6 — 2025-11-25

- Update subagents and conductor agent; remove Rust instructions
- Update subagents, instructions and Copilot instructions
- Update implement and planning subagents and conductor agent
- Update planning subagent, instructions and Copilot instructions
- Update code-review and implement subagents and conductor agent
- Add subagents and Rust instructions; update agents; remove agents

## v0.0.5 — 2025-11-12

- Replace chatmodes with agents; update Copilot instructions

## v0.0.4 — 2025-10-22

- Add ui-ux-design chatmode; update chatmodes and instructions

## v0.0.3 — 2025-10-19

- Update planning chatmode; remove ui-ux-design chatmode
- Add ui-ux-design chatmode; update TypeScript instructions
- Update planning chatmode
- Update chatmodes, instructions and Copilot instructions

## v0.0.2 — 2025-10-04

- Update chatmodes, instructions and Copilot instructions
- Update beast-mode and planning chatmodes
- Update Copilot instructions
- Update planning chatmode
- Update beast-mode and planning chatmodes and Copilot instructions
- Update beast-mode and planning chatmodes
- Update beast-mode chatmode
- Update beast-mode and planning chatmodes and TypeScript instructions
- Update beast-mode and planning chatmodes
- Add TypeScript instructions; update chatmodes; remove Rust instructions

## v0.0.1 — 2025-09-09

- Add Rust instructions; remove TypeScript instructions
- Update beast-mode chatmode; remove ui-ux-design chatmode
- Update chatmodes, TypeScript instructions and Copilot instructions
- Update beast-mode and planning chatmodes; remove implementation chatmode
- Add implementation chatmode; update planning chatmode
- Update planning chatmode
- Update beast-mode and ui-ux-design chatmodes and Copilot instructions
- Update Copilot instructions
- Update Copilot instructions
- Update chatmodes and Copilot instructions
- Add chatmodes; update chatmodes, instructions and Copilot instructions
- Update chatmodes, TypeScript instructions and Copilot instructions
- Update Copilot instructions
- Update chatmodes and Copilot instructions; remove agent directive
- Add agent directive; update Copilot instructions
- Update beast-mode and planning chatmodes
- Update TypeScript instructions and Copilot instructions
- Update TypeScript instructions
- Update chatmodes, instructions and Copilot instructions
- Update planning chatmode
- Update beast-mode chatmode
- Update beast-mode and planning chatmodes and Copilot instructions
- Update beast-mode and planning chatmodes
- Update chatmodes, TypeScript instructions and Copilot instructions
- Update planning chatmode
- Add chatmodes and TypeScript instructions; update Copilot instructions
- Update Copilot instructions
- Update Copilot instructions
- Update Copilot instructions
- Update Copilot instructions
- Update Copilot instructions
- Update Copilot instructions
- Update Copilot instructions
- Update Copilot instructions
- Add Copilot instructions
