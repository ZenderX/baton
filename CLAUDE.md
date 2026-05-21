# Claude Code Skills & Agents — Conductor Entrypoint

## Workflow

| Tier | When | Action |
|------|------|--------|
| **Single-agent** | Simple tasks, small edits | Handle directly in this session |
| **Direct delegation** | Self-contained tasks | Route to one subagent |
| **Lightweight workflow** | Moderate multi-file tasks | `sequentialthinking` → read key files → implement → review |
| **Full workflow (parallel)** | Complex multi-phase tasks | Research → Plan → Implement → Review |

## Invoke via CLI

For a dedicated conductor session:
```
claude --agent conductor
```

**In-session:** Use the `Agent` tool with the `conductor` agent.

The conductor operates on the **Blackboard model**: its context window is the project's shared memory. It holds a distilled, evolving understanding of the task. Subagents are stateless workers — each receives a tight brief extracted from that working model, executes, and posts results back. The conductor distills those results, discards the raw output, updates its model, and proceeds autonomously.

This keeps context focused, the prompt cache warm, and the concept coherent across phases — without compaction eroding the mental model.

The conductor routes to the lightest workflow that fits:
- **Direct delegation** — routes simple tasks straight to the right subagent
- **Lightweight workflow** — conductor reads code itself, plans internally, delegates implementation and review
- **Full workflow** — planning-subagent for deep codebase research, research-subagent for external docs, then implementation and review phases

### When NOT to use the conductor

- Single-file edits, quick fixes, or questions — work directly
- Pure research or documentation lookup — use `claude --agent research-subagent`

## MCP Servers

- **sequential-thinking** — structured reasoning for planning and analysis
- **context7** — up-to-date library/framework documentation lookup
