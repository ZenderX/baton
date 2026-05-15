# Claude Code Skills & Agents

An isolated repository for developing and refining Claude Code agent patterns. The `.claude/` folder is the deployable artifact — copy it into any project to get the full workflow.

## Purpose

Agent patterns are iterated here, in isolation from any specific codebase. When a pattern is stable, the `.claude/` folder (and optionally `CLAUDE.md`) is deployed to target projects. This separation keeps pattern development clean and prevents project-specific concerns from polluting the agent definitions.

## Structure

```
Skills/
├── CLAUDE.md                       # Workflow instructions (deployed with .claude/)
├── .mcp.json                       # MCP server configuration (deploy as needed)
└── .claude/
    ├── agents/
    │   ├── conductor.md            # Orchestrator — routes tasks to the right workflow tier
    │   ├── planning-subagent.md    # Codebase research & architecture analysis
    │   ├── research-subagent.md    # External-only research (no codebase involvement)
    │   ├── implement-subagent.md   # Code generation & refactoring
    │   └── code-review-subagent.md # Build/lint/test verification & quality review
    └── skills/
        ├── typescript/
        │   └── SKILL.md            # TypeScript & Vue 3 coding standards
        └── git-diff/
            └── SKILL.md            # Structured git branch comparison
```

## Deployment

Copy `.claude/` and `CLAUDE.md` into the root of any target project:

```bash
cp -r /absolute/path/to/baton/.claude /path/to/target-project/
cp /absolute/path/to/baton/CLAUDE.md /path/to/target-project/
```

Deploy `.mcp.json` only if the target project does not already have one, or merge the server entries manually.

## Usage

**Most tasks — run directly:**

```bash
claude
```

Use the default session. Only escalate to the conductor when a task overflows a single context window or has genuinely independent parallel workstreams.

**Complex or multi-phase tasks:**

```bash
claude --agent conductor
```

**Direct subagent invocation:**

```bash
claude --agent implement-subagent
claude --agent planning-subagent
```

---

## Agents

### Conductor

Routes tasks to the lightest workflow that fits. Reads project files directly for routing decisions. Runs autonomously — surfaces decisions to the user only when a genuine architectural choice requires their input.

**Workflow tiers (lightest first):**

| Tier | When |
|------|------|
| **Single-agent** | Default — handles the task directly, no subagents |
| **Direct delegation** | One self-contained task routed to a single subagent |
| **Lightweight** | Reads key files, optional planning-subagent, implement → review |
| **Full (parallel)** | Independent workstreams spawned in parallel via `run_in_background: true` |

**Key design decisions:**
- Reads project files directly — avoids a distillation layer for routing decisions
- Delegates only large-output operations (test runs, log processing) to subagents
- All file mutations go through subagents; conductor is read-only on project files
- Cross-subagent state sharing via `task-state.md` on disk, not through the conductor's context

### Planning Subagent

Codebase researcher and architect. Searches files, reads code, analyzes patterns, and returns a structured findings report. Handles library documentation via Context7 — no separate research-subagent call needed for library questions.

**MCP:** sequential-thinking, context7

### Research Subagent

External-only research: documentation, library evaluation, ecosystem comparisons, web sources. Invoke only when the task has no codebase involvement. For mixed tasks (codebase + library docs), planning-subagent covers both.

**MCP:** context7, sequential-thinking

### Implement Subagent

Autonomous code writer. Executes implementation tasks from the conductor's brief, mirrors existing codebase patterns, verifies builds pass, and reports back. Has the TypeScript skill preloaded.

**MCP:** context7, sequential-thinking  
**Skills:** typescript

### Code Review Subagent

Invoked after each implementation phase. Runs the full verification suite (`build`, `type-check`, `lint`, `test`) and reviews code quality. Returns a structured verdict — `APPROVED`, `NEEDS_REVISION`, or `FAILED` — with specific file/line references. Never applies fixes.

**MCP:** sequential-thinking, context7

---

## Skills

### TypeScript

Applied automatically to `**/*.ts`, `**/*.tsx`, `**/*.vue` files. Enforces strict TypeScript, Vue 3 `<script setup lang="ts">`, and project conventions.

Invoke manually with `/typescript`.

### Git Diff

Structured branch comparison — commit log, file stats, scope assessment. Used by the conductor when assessing change scope.

Invoke with `/git-diff`.

---

## MCP Servers

Configured in `.mcp.json`.

| Server | Transport | Purpose |
|--------|-----------|---------|
| `sequential-thinking` | stdio (`npx`) | Structured reasoning for planning and decomposition |
| `context7` | HTTP | Up-to-date library and framework documentation |

The `sequential-thinking` server requires Node.js and installs automatically via `npx`. The `context7` server is a remote HTTP endpoint — no local installation needed.

Verify servers are connected inside a session with `/mcp`.
