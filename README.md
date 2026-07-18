# Claude Code Agent Pattern Lab

An isolated lab for developing Claude Code agent patterns. `.claude/` is the deployable artifact — deploy it to any project via `sync-global.ps1`.

---

## Deploying (sync global)

```powershell
pwsh scripts/sync-global.ps1
```

Clean-copies `.claude/{agents,rules,skills}` into `~/.claude/`. Each synced subdir is removed then re-copied, so deleted files don't persist in the destination.

Run this after editing any agent, rule, or skill.

**Does NOT sync:** `agent-memory/` (project-local vault) or `settings.json`.

```powershell
pwsh scripts/sync-global.ps1 -DryRun   # preview without applying
```

---

## Running

```bash
claude --agent conductor
```

The conductor is the **top-level agent** for all orchestrated work. It is invoked directly via the CLI — nothing spawns it from a default session.

Direct subagent runs are fine for one-off tasks:

```bash
claude --agent research-subagent
claude --agent planning-subagent
```

---

## Agents

| Agent | Role |
|-------|------|
| **conductor** | Orchestrator. Blackboard model — holds the evolving task model, delegates to specialists in isolated contexts, distills results, proceeds autonomously. Entrypoint for Research → Planning → Implementation → Review. |
| **planning-subagent** | Codebase analyst and architect. Reads the project, decomposes work, and produces a sequenced `task-plan.md`. Uses sequential-thinking. |
| **research-subagent** | External research only (no codebase access). Covers library docs, API reference, web facts, latest versions. Uses context7 + sequential-thinking. |
| **implement-subagent** | Autonomous code writer. Owns architectural decisions within each phase. Reads `task-plan.md`, implements, verifies. Uses context7 + sequential-thinking. Skills: bevy, rust, typescript, vue3. |
| **code-review-subagent** | Post-implementation review. Verifies correctness, semantic integrity, and best practices. Returns `APPROVED`, `NEEDS_REVISION`, or `FAILED`. Never applies fixes. Uses context7 + sequential-thinking. Skills: git-diff, vue3, typescript, rust, bevy. |

---

## Skills

Skills in `.claude/skills/` are loaded by subagents that declare them:

| Skill | Purpose |
|-------|---------|
| `bevy` | Bevy game engine patterns |
| `blender` | Blender scripting conventions |
| `git-diff` | Structured branch comparison |
| `memory-review` | Vault accuracy review procedure |
| `rust` | Rust coding standards |
| `typescript` | TypeScript / Vue 3 coding standards |
| `vue3` | Vue 3 component patterns |

---

## Memory (Obsidian vault)

`.claude/agent-memory/` is a per-subagent memory vault browsable in Obsidian. Each subagent folder (`conductor/`, `implement-subagent/`, …) holds topic-slug notes with YAML frontmatter and wikilinks.

**Quick setup:** Install [Obsidian](https://obsidian.md), then **Open → Open folder as vault** and select `.claude/agent-memory/`. Open **Graph View** and enable **Filters → Tags** to see `type/*`, `topic/*`, and `agent/*` tag hubs connect notes across agent folders.

### Opening & Configuring in Obsidian

A step-by-step setup. Wikilinks resolve vault-wide across all subfolders, so cross-agent `[[links]]` connect in the graph.

#### 1. Open the folder as a vault
1. Install Obsidian (https://obsidian.md), then **Open → Open folder as vault**.
2. Select `.claude/agent-memory/` (the folder itself — not the repo root, not a subagent folder). Each subagent folder (`conductor/`, `planning-subagent/`, …) becomes a group within the one vault.
3. Obsidian writes a config folder at `.claude/agent-memory/.obsidian/`. If you don't want per-user UI state committed, add this to the repo's `.gitignore`:
   ```
   .claude/agent-memory/.obsidian/
   ```

#### 2. Files & Links settings  (Settings → Files and links)
- **New link format:** `Shortest path when possible` — bare `[[topic-slug]]` resolves because filenames are unique vault-wide.
- **Use Wikilinks:** ON (the double-bracket link style, not Markdown links).
- **Default location for new notes:** `In the folder specified below` → set to the agent folder you're writing for (or leave default; the conductor/subagents set paths themselves).
- **Detect all file extensions:** optional.

#### 3. Graph View  (left ribbon "Graph view", or ⌘/Ctrl-G)
Open **Graph settings** (the gear / the collapsible panels on the left of the graph), then:
- **Filters → Tags: ON** — your `type/*`, `topic/*`, `agent/*` tags become **hub nodes**. The `topic/*` tags are the cross-cutting connectors that link subjects *across* agent folders — this is the "subject relation" view.
- **Filters → Orphans:** toggle on/off to spot notes with no links (the linter also flags these).
- **Filters → Existing files only:** ON hides unresolved "ghost" nodes; turn OFF to also see forward-links to not-yet-written notes.
- **Groups → New group** (color-codes nodes; first match wins, so list specific queries above broad ones):
  | Query | Effect |
  |-------|--------|
  | `path:conductor` | one color per agent folder (add one per folder) |
  | `tag:#type/research` | one color per memory type |
  | `tag:#topic/memory` | spotlight a subject cluster across folders |
- **Display:** raise "Link thickness" / "Text fade threshold" to taste; the MEMORY.md index notes naturally appear as hubs.

#### 4. Properties & Tags panes
- Open the **Tags** core plugin pane (right sidebar) to browse the `type/ topic/ agent/` taxonomy and click a tag to filter.
- The **Properties** view renders `tags`, `aliases`, `metadata.*` per note (Obsidian 1.4+).

#### 5. Optional plugins (not required — `scripts/memory-lint.ps1` already does this deterministically)
- *Find Unlinked Files* — orphan + broken-link report.
- *Broken Links* — sidebar panel of unresolved links.

> Note: memory is **project-local** by design (`sync-global.ps1` doesn't sync `agent-memory/`). Each project where you run the conductor gets its own `agent-memory/` vault — open each separately.

**Tooling:**
- `pwsh scripts/memory-lint.ps1` — deterministic linter: broken links, missing tags, stale research, MEMORY.md mismatches. Exits non-zero on integrity errors.
- `.claude/skills/memory-review/` — judgment skill for accuracy review against current repo state. Run monthly or after major changes.

Memory is project-local — `sync-global.ps1` does not sync it.

---

## Installing via the Plugin Marketplace (for friends)

This repo also ships as a private Claude Code plugin marketplace (`.claude-plugin/marketplace.json`, name `skills-marketplace`), so friends can install the conductor pattern and domain skills without cloning and running `sync-global.ps1` themselves.

**Prerequisite:** the rules-delivery hook (below) is a `pwsh` script, so friends need **PowerShell 7** installed — https://aka.ms/pwsh.

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

Which plugins are enabled lives in `enabledPlugins` in your own `settings.json` — this is machine-local config, the same preserve-listed key `sync-global.ps1` already carries across resyncs on this machine (see [Deploying](#deploying-sync-global)), so installing plugins here doesn't interact with that script at all.

**Running the conductor** once `conductor-core` is installed is the same top-level invocation as above: `claude --agent conductor`. If a project- or user-level agent of the same name shadows the plugin's, scope it explicitly: `claude --agent conductor-core:conductor`.

**Rules still apply, but travel differently.** Plugins can't carry `.claude/rules/` or `CLAUDE.md` directly, so `conductor-core` ships a `SessionStart` hook that emits `.claude/rules/engineering-rules.md` and `.claude/rules/git-hygiene.md` as injected context on every session start — friends get the same rules with no extra setup, provided PowerShell 7 (above) is present.

**Permissions can't ship in a plugin either** — a plugin's own `settings.json` only supports `agent`/`subagentStatusLine` keys, not `permissions.deny`. Friends who want the deterministic git-mutation guard (not just the advisory rule) need to add this block to their own `~/.claude/settings.json` (or a project `settings.json`) themselves — copied verbatim from this repo's `.claude/settings.json`:

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

**Sending memory back upstream.** Friends running the conductor from a plain plugin install (no local `.claude-plugin/marketplace.json` + `scripts/sync-global.ps1` — i.e. not this canonical workbench) aren't able to promote memory notes into agent/skill/rule files directly. Instead, candidate promotions accumulate locally in `~/.claude/agent-memory/promotion-queue/` (mechanics documented in `.claude/skills/memory-review/SKILL.md`). Send those upstream by opening an issue or PR against this repo — the workbench drains the queue on its next memory review.

---

## Git Hygiene

Agents never mutate git state. Enforced by two layers:

1. **Rule** — `.claude/rules/git-hygiene.md` instructs all agents to treat git as read-only.
2. **Deny list** — `permissions.deny` in `settings.json` hard-blocks mutating commands.

There is no PreToolUse hook backstop — a prior `.claude/hooks/block-git-writes.ps1` hook was removed; the deny list is the sole deterministic enforcement layer, backed by the advisory rule.

Read-only git (`status`, `diff`, `log`, `blame`, `show`, `branch` listing) is fully allowed.

---

## MCP Servers

Configured in `.mcp.json`. Verify connections inside a session with `/mcp`.

| Server | Purpose |
|--------|---------|
| `sequential-thinking` | Structured reasoning for planning and decomposition |
| `context7` | Up-to-date library and framework documentation |
