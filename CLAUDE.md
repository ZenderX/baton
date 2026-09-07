# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

A private **marketplace of Claude Code plugins** that is simultaneously a **pi package**. The same source tree is consumed by two different agent harnesses, without copying or a build step:

- **Claude Code** loads `plugins/*/` via `.claude-plugin/marketplace.json` (agents, skills, hooks, MCP servers).
- **pi** (`@earendil-works/pi-coding-agent`) loads `pi/` plus the same `plugins/*/skills` via the `pi` key in `package.json`.

The primary product is the **conductor**: an orchestrator plus five subagents (`planning`, `research`, `implement`, `code-review`, `memory`) that delegate work to each other, with domain skills for Bevy, Blender, Rust, TypeScript, and Vue 3.

There is no build, bundle, or deploy step. Editing a file here changes agent behaviour at the next harness restart.

## The dual-harness rule (most important thing to know)

Agent definitions exist **twice**, as parallel Markdown prompts for the two harnesses:

| Concern | Claude Code | pi |
|---|---|---|
| Agent definitions | `plugins/conductor/agents/*.md` | `pi/agents/*.md` |
| Orchestrator prompt | `plugins/conductor/agents/main.md` | `pi/extensions/conductor/orchestrator.md` |

**Prose in these files must stay in sync. When you change one tree, change the other in the same pass.** Parity is required *per agent between the two trees* — `pi/agents/code-review.md` must match `plugins/conductor/agents/code-review.md`. It is **not** required across different agents: per-agent differences (for example each agent's own tie-break clause) are deliberate and must be preserved.

Divergence is legitimate **only** where harness capability forces it:

- **Frontmatter is never synced.** pi uses lowercase `tools:`, `excludeTools:`, `spawn:`, inline-array `skills:`, `thinking:`. Claude Code uses CamelCase `tools:` with `mcp__*` ids, `disallowedTools:`, `model:`, `effort:`, block-list `skills:`.
- **Tool dialect** differs in prose: `read`/`grep`/`find`/`bash`/`sequential_thinking`/`subagent` (pi) vs `Read`/`Grep`/`Glob`/`Bash`/`mcp__sequential-thinking__sequentialthinking`/`Agent` (Claude Code).
- **Capability gaps.** pi has no `Skill` tool, no Context7, no `WebFetch`/`WebSearch`, and no `${CLAUDE_PLUGIN_ROOT}`; it reads preloaded SKILL.md paths, fetches via `curl -sL` in `bash`, and derives a package root from the skills preamble. Claude Code has the inverse.

Anything else that differs is drift and should be reconciled.

`plugins/conductor/agents/main.md` is Claude Code-only; its pi counterpart lives in `pi/extensions/conductor/orchestrator.md` because pi delivers the orchestrator as an extension prompt rather than an agent file.

## Editing agent prompts

These files are system prompts. Changes to them are behavioural changes, so:

- **Verify claims against the harness before writing them.** A prompt asserting a mechanism that does not exist actively misleads the agent. Frontmatter `tools:` is authoritative for what an agent can call; `plugins/conductor/.mcp.json` for MCP tools; `plugins/*/skills/*/SKILL.md` for skills; `.claude/settings.json` for env and permissions. Past defects have included citing a `permissions.deny` that was never configured and warning against invoking a "skill" that is actually a tool.
- **Avoid intensifiers on habitual tool-call instructions.** Do not add "unconditionally", "always", "mandatory", or "critical" to drive adoption of a routine tool call. Heavy phrasing reads as high-ceremony ritual reserved for big tasks and *suppresses* use; plain phrasing increases it.
- **Match the surrounding structure.** In a `## Tool Usage` bullet list where every entry reads ``- `tool` — <what it is for>``, do not add a "call the tool" predicate — the label already names it.
- Claude Code preloads skills declared in an agent's `skills:` frontmatter directly into its prompt; instructing a separate `Skill` call for that content is redundant.

## Line endings (this will bite you)

Committed blobs are **LF**; `.gitattributes` normalizes checkouts (`*.md` checks out CRLF on Windows, `*.ts`/`*.ps1`/`*.sh` LF). Depending on the checkout, working-tree Markdown may therefore be CRLF while the repo content is LF. GNU `sed -i` under Git Bash rewrites line endings across the whole file, turning a one-line edit into a whole-file diff.

- Use the `Edit`/`Write` tools for Markdown edits here, not `sed -i`.
- Verify with `tr -dc '\r' < file | wc -c` compared against `tr -dc '\n' < file | wc -c`. **Do not use `grep` to detect CR** — it is unreliable in this environment.
- `.ps1` files under `scripts/` are LF by convention; do not "fix" them to CRLF.

## Commands

There is no test suite, no linter, and no build. The only checks available:

```bash
# Typecheck the pi extensions (noEmit — no output is produced)
npx tsc -p pi/tsconfig.json

# Lint the memory vault (PowerShell 7 required)
pwsh ./plugins/conductor/scripts/memory-lint.ps1
```

Repo tooling requires **PowerShell 7 Core (`pwsh`)**; Windows PowerShell 5.1 is explicitly unsupported and the scripts error out on it. `scripts/sync-global.ps1` merges `.claude/settings.json` into the user's global settings; `scripts/clean-global.ps1` is its counterpart. Both accept `-DryRun`.

Git-Bash note: compound `cd … && git …` invocations can be denied by the permission system — use `git -C <abs-path> …` instead.

## Layout that isn't obvious

- `plugins/conductor/skills/` holds procedure skills (`memory-write`, `memory-review`, `git-diff`) consumed by the agents, **not** documentation for humans.
- `.claude/agent-memory/conductor-main/` is the conductor's persistent memory vault: `MEMORY.md` is a one-line-per-note index, with each note a separate file carrying frontmatter and `[[wikilinks]]`. Only the `memory` subagent writes here.
- `.claude/conductor/environment.md` is generated once then user-owned; briefs carry only its path; subagents read it on demand.
- `pi/extensions/conductor/` is the pi-side implementation (TypeScript) that registers the orchestrator, the `sequential_thinking` tool, and the subagent spawn allow-list — pi has no MCP, so tools that arrive via MCP in Claude Code are implemented natively here.
- `releases/` and `node_modules/` are not part of the source of truth.

## Documentation language

README and all documentation are written in **English**, regardless of the language used in conversation.
