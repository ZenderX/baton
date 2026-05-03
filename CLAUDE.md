# Claude Code Skills & Agents

## Workflow

### Always delegate to the conductor

**From the CLI:**
```
claude --agent conductor
```

**In-session:** Use the `Agent` tool with the `conductor` agent. Provide a clear, concise task description and let the conductor handle the rest.

The conductor operates on the **Blackboard model**: its context window is the project's shared memory. It holds a distilled, evolving understanding of the task. Subagents are stateless workers — each receives a tight brief extracted from that working model, executes, and posts results back. The conductor distills those results, discards the raw output, updates its model, and proceeds autonomously.

This keeps context focused, the prompt cache warm, and the concept coherent across phases — without compaction eroding the mental model.

The conductor routes to the lightest workflow that fits:
- **Direct delegation** — routes simple tasks straight to the right subagent
- **Lightweight workflow** — conductor reads code itself, plans internally, delegates implementation and review
- **Full workflow** — planning-subagent for deep codebase research, research-subagent for external docs, then implementation and review phases
