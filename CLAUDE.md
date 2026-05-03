# Claude Code Skills & Agents

## Workflow

### When to use the conductor

For any task that involves **implementation plus at least one other phase** (research, planning, or review) — delegate to the conductor agent.

**From the CLI:**
```
claude --agent conductor
```

**In-session:** Use the `Agent` tool with the `conductor` agent — the conductor is an agent, not a skill. Never invoke it with `/conductor`.

The conductor operates on the **Blackboard model**: its context window is the project's shared memory. It holds a distilled, evolving understanding of the task. Subagents are stateless workers — each receives a tight brief extracted from that working model, executes, and posts results back. The conductor distills those results, discards the raw output, updates its model, and proceeds autonomously.

This keeps context focused, the prompt cache warm, and the concept coherent across phases — without compaction eroding the mental model.

The conductor routes to the lightest workflow that fits:
- **Direct delegation** — routes simple tasks straight to the right subagent
- **Lightweight workflow** — conductor reads code itself, plans internally, delegates implementation and review
- **Full workflow** — planning-subagent for deep codebase research, research-subagent for external docs, then implementation and review phases

### When NOT to use the conductor

- Single-file edits, quick fixes, or questions — work directly
- Pure research or documentation lookup — use `claude --agent research-subagent`

## Coding Standards

TypeScript and Vue 3 standards are enforced via the `typescript` skill (auto-loaded for `*.ts`, `*.tsx`, `*.vue` files). Key rules:
- Strict mode: no `any`, no `!`, no `as unknown`
- Vue 3 `<script setup lang="ts">` with typed props/emits
- Double-quote strings

## MCP Servers

- **sequential-thinking** — structured reasoning for planning and analysis
- **context7** — up-to-date library/framework documentation lookup
