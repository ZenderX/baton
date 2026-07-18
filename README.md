# Claude Code Agent Pattern Lab

A Claude Code agent ecosystem: an orchestrator (the **conductor**) that delegates codebase work to specialist subagents, each with persistent per-project memory and a self-improvement loop that promotes durable lessons back into the agents' own instructions.

This repo is both:
- **The canonical workbench** — where the conductor, subagents, skills, and rules are authored (`.claude/`).
- **A plugin marketplace** (`skills-marketplace`) — the same content, packaged for distribution so anyone can install the pattern without cloning this repo.

---

## Quick Start (for consumers)

**Prerequisites:** [Claude Code](https://docs.claude.com/en/docs/claude-code), and **PowerShell 7** (https://aka.ms/pwsh) — the rules-delivery hook (below) is a `pwsh` script.

**Add the marketplace, then install plugins:**

```
/plugin marketplace add <owner>/<repo>
/plugin install conductor-core@skills-marketplace
/plugin install bevy@skills-marketplace
/plugin install blender@skills-marketplace
/plugin install rust@skills-marketplace
/plugin install typescript@skills-marketplace
/plugin install vue3@skills-marketplace
```

(`<owner>/<repo>` is this repository's GitHub path; a local checkout path also works with `/plugin marketplace add /absolute/path/to/baton`.)

Plugin entries in `marketplace.json` omit `version` — git-source plugins float with the repo, so every commit is a new version. Refresh installed plugins after upstream changes with:

```
/plugin marketplace update skills-marketplace
```

**Plugins shipped:**

| Plugin | Contents |
|--------|----------|
| `conductor-core` | conductor + 5 subagents, their 8 preloaded skills (incl. `git-diff`), the `SessionStart` rules-delivery hook, and `.mcp.json` (`sequential-thinking`, `context7`) |
| `bevy` | Bevy skill — standalone, no agents |
| `blender` | Blender (bevy_skein) skill — standalone, no agents |
| `rust` | Rust skill — standalone, no agents |
| `typescript` | TypeScript skill — standalone, no agents |
| `vue3` | Vue 3 skill — standalone, no agents |

**Run the conductor** — the top-level entrypoint for all orchestrated work:

```bash
claude --agent conductor
```

If a project- or user-level agent of the same name shadows the plugin's, scope it explicitly: `claude --agent conductor-core:conductor`.

**Recommended: add the deterministic git-mutation guard.** Plugins can't ship `permissions.deny` — a plugin's own `settings.json` only supports `agent`/`subagentStatusLine` keys — so add this block to your own `~/.claude/settings.json` (or a project `settings.json`) yourself, copied verbatim from this repo's `.claude/settings.json`:

```json
{
  "permissions": {
    "deny": [
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(git push:*)",
      "Bash(git pull:*)",
      "Bash(git fetch:*)",
      "Bash(git reset:*)",
      "Bash(git restore:*)",
      "Bash(git checkout:*)",
      "Bash(git switch:*)",
      "Bash(git rebase:*)",
      "Bash(git merge:*)",
      "Bash(git cherry-pick:*)",
      "Bash(git revert:*)",
      "Bash(git clean:*)",
      "Bash(git rm:*)",
      "Bash(git mv:*)",
      "Bash(git commit-tree:*)",
      "Bash(git update-ref:*)",
      "Bash(git branch:*)",
      "Bash(git tag:*)",
      "Bash(git stash:*)",
      "Bash(git worktree:*)",
      "Bash(git remote:*)",
      "Bash(git notes:*)"
    ]
  }
}
```

---

## How It Works

### The conductor pattern

The **conductor** is a blackboard orchestrator: it holds the evolving task model in its own context, delegates focused briefs to stateless specialist subagents, distills their results back into its working model, and proceeds — without stopping between phases unless a genuine decision needs the user. It is always the top-level agent (`claude --agent conductor`); nothing spawns it, and it never does specialist work itself.

| Agent | Role | Model | Skills preloaded |
|-------|------|-------|-------------------|
| **conductor** | Orchestrator. Holds the shared task model, delegates to specialists, distills results, proceeds autonomously. Entrypoint for Research → Planning → Implementation → Review. | inherit | — |
| **planning-subagent** | Codebase analyst and architect. Reads the project, decomposes work, produces a sequenced `task-plan.md`. | sonnet | — |
| **research-subagent** | External research only (no codebase access). Library docs, API reference, web facts, latest versions. | sonnet | — |
| **implement-subagent** | Autonomous code writer. Owns architectural decisions within each phase. Reads `task-plan.md`, implements, verifies. | sonnet | bevy, rust, typescript, vue3 |
| **code-review-subagent** | Post-implementation review. Verifies correctness, semantic integrity, best practices. Returns `APPROVED`, `NEEDS_REVISION`, or `FAILED`. Never applies fixes. | sonnet | git-diff, vue3, typescript, rust, bevy |
| **memory-subagent** | Post-task dirty propagator and topic steward. Flags 1-hop neighbor memories stale after any memory write, reconciles the emergent `topic/*` taxonomy. Conductor-only trigger — subagents never invoke it directly. | haiku | memory-write, obsidian-links |

### Skills

Skills in `.claude/skills/` encode domain conventions and procedures. Agents declare the ones they need in their `skills:` frontmatter list — the full skill content is **preloaded** (injected at agent start), not fetched on demand.

| Skill | Purpose |
|-------|---------|
| `bevy` | Bevy game engine patterns |
| `blender` | Blender-to-Bevy (bevy_skein) integration conventions |
| `git-diff` | Structured branch comparison |
| `memory-review` | Vault accuracy review procedure |
| `memory-write` | Memory note-writing conventions — schema, type selection, dirty-flag clearing |
| `obsidian-links` | Wikilink conventions for connecting memory notes |
| `rust` | Rust coding standards |
| `typescript` | TypeScript coding standards |
| `vue3` | Vue 3 component patterns |

### Rules

`.claude/rules/engineering-rules.md` and `.claude/rules/git-hygiene.md` are the standing instructions every agent operates under. They travel two ways:

- **Locally** — `sync-global.ps1` clean-copies `.claude/rules/` into `~/.claude/rules/` alongside agents and skills.
- **To plugin consumers** — `conductor-core` ships a `SessionStart` hook (`hooks/emit-rules.ps1`) that emits both rules files as injected context on every session start, so friends get the same rules with no extra setup (PowerShell 7 required — see Quick Start).

### The learning loop

This is the system's actual point: it gets better at the tasks it's used for, and those improvements compound across projects.

```
agent completes a task
   │  writes/updates memory notes (.claude/agent-memory/*, an Obsidian-compatible vault)
   ▼
memory-subagent flags 1-hop neighbor notes dirty (every task, conductor-triggered)
   ▼
memory-review skill audits the vault (monthly, or on trigger)
   │  verifies claims, reconciles contradictions, prunes stale notes
   │  asks of each durable note: "would every future session in every project need this?"
   ▼
   ├─ in the canonical workbench (marker files: .claude-plugin/marketplace.json
   │  AND scripts/sync-global.ps1 both present) ─▶ promote: edit the canonical
   │  agent/rule/skill file directly under .claude/{agents,rules,skills}
   │      └─▶ next commit + `/plugin marketplace update` redistributes to consumers
   │
   └─ anywhere else (plain plugin install, no local marketplace) ─▶ queue the
      candidate in ~/.claude/agent-memory/promotion-queue/<slug>.md, then send
      it upstream via a GitHub issue or PR
          └─▶ workbench drains the queue on its next memory review (step 1)
```

Workbench identity is checked by file presence, never by path, so the same logic works identically on any machine. Project-specific facts, decaying research, and recurring-judgment heuristics stay in the vault — only durable, generalizable lessons get promoted.

---

## Maintainer Guide (this workbench)

If you're editing agents, rules, or skills directly in this repo, three scripts under `scripts/` keep the deployed and distributable copies in sync with the canonical `.claude/` source.

### `sync-global.ps1` — deploy to your machine

```powershell
pwsh scripts/sync-global.ps1
pwsh scripts/sync-global.ps1 -DryRun   # preview without applying
```

Run this after editing any agent, rule, or skill. It:
- Clean-replaces `agents/`, `rules/`, and `skills/` under `~/.claude/` (each subdir is removed then re-copied, so deleted source files don't persist).
- **Does** sync `settings.json` — a repo-authoritative merge: the repo copy wins on everything, including deletions, except a small preserve-list of machine-local keys (`model`, `tui`, `enabledPlugins`) that survive from the deployed copy.
- Merges `.claude/agent-memory/.obsidian/graph.json` the same way (repo wins on colorGroups/search/display; a preserve-list of machine-local view-state keys — force-layout tuning, zoom, panel collapse — survives).
- Registers each server in `.mcp.json` into Claude Code's user scope via `claude mcp add-json`.
- **Does NOT sync** `agent-memory/` (the memory vault is project-local by design).

### `build-plugins.ps1` — regenerate distributable plugins

```powershell
pwsh scripts/build-plugins.ps1
pwsh scripts/build-plugins.ps1 -DryRun
```

Regenerates `plugins/<name>/` from the canonical `.claude/agents`, `.claude/skills`, and root `.mcp.json`. **Never hand-edit generated content** — run this after editing agents, skills, or rules, and before publishing (committing / `/plugin marketplace update`).

Hand-authored exceptions this script never touches: each plugin's `.claude-plugin/plugin.json`, and — for `conductor-core` only — `hooks/hooks.json` and `hooks/emit-rules.ps1` (only `hooks/rules.md` inside that folder is generated).

### `memory-lint.ps1` — deterministic vault linter

```powershell
pwsh scripts/memory-lint.ps1
pwsh scripts/memory-lint.ps1 -Fix   # safe, idempotent auto-repairs
```

Checks the `.claude/agent-memory/` vault for broken links, missing tags, stale research, and `MEMORY.md` index mismatches. Exits non-zero on integrity errors. `.claude/skills/memory-review/` is the companion judgment skill — run it for accuracy review against current repo state (monthly, or after major changes); it runs the linter first, then applies judgment the linter can't (verify, reconcile, prune, promote).

### Memory vault + Obsidian setup

`.claude/agent-memory/` is a per-subagent memory vault, browsable in Obsidian. Each subagent folder (`conductor/`, `implement-subagent/`, …) holds topic-slug notes with YAML frontmatter and wikilinks; cross-agent `[[links]]` resolve vault-wide.

**Setup:**
1. Install [Obsidian](https://obsidian.md) → **Open → Open folder as vault** → select `.claude/agent-memory/` (the folder itself, not the repo root or a subagent folder).
2. **Settings → Files and links:** set **New link format** to `Shortest path when possible` and **Use Wikilinks: ON**, so bare `[[topic-slug]]` links resolve (filenames are unique vault-wide).
3. **Graph view** (⌘/Ctrl-G): enable **Filters → Tags** to turn `type/*`, `topic/*`, `agent/*` into hub nodes — `topic/*` is the cross-cutting connector linking subjects across agent folders. Use **Groups** to color-code by `path:<agent>` or `tag:#type/*` (list specific queries above broad ones — first match wins).
4. The **Tags** and **Properties** side panes browse the taxonomy and render `metadata.*` per note.
5. Optional: *Find Unlinked Files* / *Broken Links* community plugins for orphan/broken-link reports — `scripts/memory-lint.ps1` already does this deterministically.
6. If you don't want per-user Obsidian UI state committed, gitignore `.claude/agent-memory/.obsidian/` (note: `graph.json` inside it is intentionally tracked and synced — see `sync-global.ps1` above).

Memory is project-local by design — `sync-global.ps1` never syncs `agent-memory/`. Each project where you run the conductor gets its own vault.

---

## Reference

### Git Hygiene

Agents never mutate git state. Enforced by two layers:

1. **Rule** — `.claude/rules/git-hygiene.md` instructs all agents to treat git as read-only.
2. **Deny list** — `permissions.deny` in `settings.json` hard-blocks mutating commands.

There is no `PreToolUse` hook backstop — a prior `.claude/hooks/block-git-writes.ps1` hook was removed; the deny list is the sole deterministic enforcement layer, backed by the advisory rule.

`git status`, `diff`, `log`, `blame`, and `show` are allowed. Everything else in the deny list above is blocked — including the dual-mode subcommands (`branch`, `tag`, `stash`, `worktree`, `remote`, `notes`) **wholesale**, which also blocks their read-only listing forms (e.g. `git branch -a`, `git remote -v`). To inspect refs read-only, use `git for-each-ref` / `git show-ref` instead.

### MCP Servers

Configured in `.mcp.json`. Verify connections inside a session with `/mcp`.

| Server | Purpose |
|--------|---------|
| `sequential-thinking` | Structured reasoning for planning and decomposition |
| `context7` | Up-to-date library and framework documentation |
