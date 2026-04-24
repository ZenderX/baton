# Claude Code Skills & Agents

A portable Claude Code configuration providing a multi-agent development workflow with sequential thinking and context-aware documentation lookup.

## Structure

```
Skills/
├── CLAUDE.md                       # Root instructions (persona + workflow hint)
├── .mcp.json                       # Shared MCP server configuration
└── .claude/
    ├── agents/
    │   ├── conductor.md            # Orchestrator — runs as main session agent
    │   ├── planning-subagent.md    # Codebase research & architecture analysis
    │   ├── research-subagent.md    # External docs, library evaluation, web research
    │   ├── implement-subagent.md   # Code generation & refactoring
    │   └── code-review-subagent.md # Build/lint/test verification & quality review
    └── skills/
        ├── typescript/
        │   └── SKILL.md            # TypeScript & Vue 3 coding standards
        └── git-diff/
            └── SKILL.md            # Structured git branch comparison
```

## Quick Start

For complex, multi-phase tasks:

```bash
claude --agent conductor
```

For direct subagent invocation:

```bash
claude --agent research-subagent
claude --agent implement-subagent
```

## Agents

### Conductor

The brain of the system. Runs as the main session agent, assesses task complexity, and delegates all work to specialized subagents. It reads code and diffs branches directly for context, but never writes code — subagents are its hands.

**Workflow tiers (lightest first):**
1. **Direct delegation** — routes simple tasks straight to the right subagent
2. **Lightweight** — conductor reads code itself, writes a plan, delegates implementation and review
3. **Full workflow** — planning-subagent for deep research, then implementation and review phases

**Stopping points** (waits for your approval):
- After presenting the plan
- After each phase review
- After plan completion

### Planning Subagent

Read-only codebase researcher. Searches files, reads code, analyzes architecture, and returns a structured findings report. Flags external research needs for the conductor to route to `research-subagent`.

**Tools:** Read, Grep, Glob, LS, Bash  
**MCP:** sequential-thinking

### Research Subagent

Technical web researcher. Uses **context7 as the primary source** for library and framework documentation (current, version-accurate), falling back to web sources for ecosystem trends, community health, and architecture comparisons.

**Tools:** Read, Bash, WebFetch  
**MCP:** context7

### Implement Subagent

Autonomous code writer. Executes implementation tasks from the conductor's plan, mirrors existing codebase patterns, and verifies builds pass. Reports back a summary for the conductor to review. Has the TypeScript skill preloaded.

**Tools:** Read, Write, Edit, Bash, Grep, Glob, LS  
**MCP:** context7  
**Skills:** typescript

### Code Review Subagent

Invoked by the conductor after each implementation phase. Runs the full verification suite (`build`, `type-check`, `lint`, `test`) and reviews code quality. Returns a structured verdict — `APPROVED`, `NEEDS_REVISION`, or `FAILED` — with specific file/line references. Never applies fixes.

**Tools:** Read, Bash, Grep, Glob, LS  
**MCP:** sequential-thinking, context7

## Skills

### TypeScript

Applied automatically to `**/*.ts`, `**/*.tsx`, `**/*.vue` files. Enforces:
- TypeScript strict mode (no `any`, no non-null assertions)
- Vue 3 `<script setup lang="ts">` with typed props/emits
- Reactivity primitives (`ref`, `reactive`, `computed`)
- Double-quote string convention
- TanStack Query injection context rules

Invoke manually with `/typescript` or let Claude load it automatically when working with TypeScript files.

### Git Diff

Compare git branches with structured output — commit log, file stats, changed file list, and scope assessment. Used by the conductor to assess change scope before routing work.

Invoke with `/git-diff` or let the conductor use it automatically when assessing branch changes.

## MCP Servers

Configured in `.mcp.json` at project scope (shared with team via version control).

| Server | Transport | Purpose |
|--------|-----------|---------|
| `sequential-thinking` | stdio (`npx`) | Structured step-by-step reasoning for planning and analysis |
| `context7` | HTTP | Up-to-date library/framework documentation lookup |

### Setup

The `sequential-thinking` server requires Node.js and is installed automatically via `npx` on first use.

The `context7` server is a remote HTTP endpoint — no local installation needed.

To verify servers are connected inside a session:

```
/mcp
```

## Plan Documents

The conductor writes plan artifacts to a `plans/` directory:

| File | When |
|------|------|
| `plans/<task>-plan.md` | After plan approval |
| `plans/<task>-phase-<N>-complete.md` | After each phase review |
| `plans/<task>-complete.md` | After all phases complete |

## Persona

> You embody the relentless focus of Bill Gates combined with the game development mastery of Tim Sweeney. World-class full-stack engineer — elegant, concise, durable implementations following all best practices.
