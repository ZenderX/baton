# Claude Code Agent Pattern Lab

A Claude Code agent ecosystem: an orchestrator (the **conductor**) that delegates codebase work to specialist subagents, each with persistent per-project memory and a self-improvement loop that promotes durable lessons back into the agents' own instructions.

This repo is both:
- **The canonical workbench** — where the conductor, subagents, and skills are authored directly in place (`plugins/`).
- **A plugin marketplace** (`skills-marketplace`) — the same content, installable by anyone via `/plugin` with no clone required.

---

## Quick Start (for consumers)

**Prerequisite:** [Claude Code](https://docs.claude.com/en/docs/claude-code). Nothing else — no PowerShell, no build step. (PowerShell is only needed by the maintainer scripts in this workbench, covered below.)

**Add the marketplace, then install plugins:**

```
/plugin marketplace add <owner>/<repo>
/plugin install conductor@skills-marketplace
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
| `conductor` | conductor + 5 subagents (6 agents total), 5 bundled skills (`git-diff`, `memory-review`, `memory-write`, `obsidian-links`, `operating-standards`; preload is selective per agent and same-plugin-only — see [Skills](#skills)), and `.mcp.json` (`sequential-thinking`, `context7`). 0 hooks. |
| `bevy` | Bevy skill — standalone, no agents |
| `blender` | Blender (bevy_skein) skill — standalone, no agents |
| `rust` | Rust skill — standalone, no agents |
| `typescript` | TypeScript skill — standalone, no agents |
| `vue3` | Vue 3 skill — standalone, no agents |

Install the language plugins relevant to what you work on alongside `conductor` — see [Skills](#skills) below for why.

**Run the conductor** — the top-level entrypoint for all orchestrated work:

```bash
claude --agent main
```

If a project- or user-level agent of the same name shadows the plugin's, scope it explicitly: `claude --agent conductor:main`.

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

The **conductor** is a blackboard orchestrator: it holds the evolving task model in its own context, delegates focused briefs to stateless specialist subagents, distills their results back into its working model, and proceeds — without stopping between phases unless a genuine decision needs the user. It is always the top-level agent (`claude --agent main`); nothing spawns it, and it never does specialist work itself.

It also fans work out: independent subagent invocations dispatch in parallel (a single message, multiple `Agent` calls — capped at 20 concurrent, 200/session), each with an explicit non-overlapping file-ownership scope so parallel briefs don't collide. And it carries no fixed roster of domain skills — before briefing a subagent, it discovers what's available by scanning `plugins/*/skills/*/SKILL.md` frontmatter and matches skills to the files actually in play (see [Skills](#skills)).

| Agent | Role | Model | Skills |
|-------|------|-------|--------|
| **main** | Orchestrator (the conductor). Holds the shared task model, delegates to specialists, distills results, proceeds autonomously. Entrypoint for Research → Planning → Implementation → Review. | inherit | operating-standards (preloaded) |
| **planning** | Codebase analyst and architect. Reads the project, decomposes work, produces a sequenced `task-plan.md`. | sonnet | operating-standards (preloaded) |
| **research** | External research only (no codebase access). Library docs, API reference, web facts, latest versions. | sonnet | operating-standards (preloaded) |
| **implement** | Autonomous code writer. Owns architectural decisions within each phase. Reads `task-plan.md`, implements, verifies. | sonnet | operating-standards (preloaded); domain standards (e.g. `rust`, `vue3`) on demand via the `Skill` tool |
| **code-review** | Post-implementation review. Verifies correctness, semantic integrity, best practices. Returns `APPROVED`, `NEEDS_REVISION`, or `FAILED`. Never applies fixes. | sonnet | operating-standards, git-diff (preloaded); domain standards on demand via the `Skill` tool |
| **memory** | Post-task dirty propagator and topic steward. Flags 1-hop neighbor memories stale after any memory write, reconciles the emergent `topic/*` taxonomy, integrates any stray notes `scripts/memory-lint.ps1` finds living outside the canonical plugin-scoped folders. Conductor-only trigger — subagents never invoke it directly. | haiku | operating-standards, memory-write, obsidian-links (preloaded) |

### Skills

Skills are authored in `plugins/<plugin>/skills/` and reach an agent through two distinct paths:

- **Preload** — named in an agent's `skills:` frontmatter, the full skill body is injected at agent start. **Measured to work same-plugin only**: a `skills:` entry naming a skill from a *different* plugin is silently dropped — no error, the content simply never arrives. `conductor`'s agents therefore only ever preload `conductor`'s own skills (see the table above).
- **On demand** — loaded mid-task via the `Skill` tool, triggered by the skill's own `paths:` glob matching a file the agent is touching. This is the only mechanism by which a skill from a *different* plugin reaches an agent, and it requires that plugin to be **installed and enabled**.

| Skill | Plugin | Purpose |
|-------|--------|---------|
| `git-diff` | conductor | Structured branch comparison |
| `memory-review` | conductor | Vault accuracy review procedure |
| `memory-write` | conductor | Memory note-writing conventions — schema, type selection, dirty-flag clearing, optional freshness/expiry metadata |
| `obsidian-links` | conductor | Wikilink conventions for connecting memory notes |
| `operating-standards` | conductor | Engineering Rules 1–13 and Git Hygiene Rules G1–G3 — mandatory for every agent |
| `bevy` | bevy | Bevy game engine patterns |
| `blender` | blender | Blender-to-Bevy (bevy_skein) integration conventions |
| `rust` | rust | Rust coding standards |
| `typescript` | typescript | TypeScript coding standards |
| `vue3` | vue3 | Vue 3 component patterns |

**Domain standards load on demand, and require the domain plugin to be enabled.** `implement` and `code-review` carry the `Skill` tool and do not list `bevy`/`rust`/`typescript`/`vue3` in `skills:` — a cross-plugin preload there was measured inert (see above), so listing them would have been a no-op that looked like coverage. Instead, each domain skill's own `paths:` glob (`**/*.rs`; `**/*.ts`, `**/*.tsx`; `**/*.vue` + composables/stores) triggers it on demand when a matching file is in play — but only if that plugin is installed *and* enabled. Install whichever language plugins match what you write (e.g. `rust` if you write Rust) alongside `conductor`. **This repository's own `.claude/settings.json` enables only `conductor`** — running this workbench as-is, without also enabling e.g. `rust`, means no Rust standards reach the agent, and both agents are instructed to say so explicitly rather than proceeding on generic knowledge.

**Cache economics behind that design choice:** every subagent spawn builds its own cache from cold, on the standard 5-minute TTL (the 1-hour TTL applies only to the main conversation) — so a preloaded skill body is paid at full input-token price on *every* invocation, with no amortization across the session. That is why preload here is reserved for `operating-standards` (small, mandatory for every agent) and `git-diff` (small, always used by code-review); the on-demand path costs only skill metadata (~50 tokens) until a matching file actually triggers it, which is cheaper for anything conditional. Separately: a project's `CLAUDE.md` loads in full into every subagent's context, not just the conductor's — six agents means a large `CLAUDE.md` is paid up to six times per task.

### How rules travel

Engineering Rules 1–13 and Git Hygiene Rules G1–G3 travel as a single preloaded skill, `operating-standards`, shipped by `conductor`. Every one of the six agents declares it in `skills:` frontmatter and — because it lives in the *same* plugin as every agent that declares it — the preload actually lands, injected into every agent's context at session start with zero extra setup: no `SessionStart` hook, no PowerShell, no separate rules directory to keep in sync. Install `conductor` and you have them, workbench or consumer alike.

### The learning loop

This is the system's actual point: it gets better at the tasks it's used for, and those improvements compound across projects.

```
agent completes a task
   │  writes/updates memory notes (.claude/agent-memory/*, an Obsidian-compatible vault)
   ▼
memory subagent flags 1-hop neighbor notes dirty (every task, conductor-triggered)
   ▼
memory-review skill audits the vault (monthly, or on trigger)
   │  verifies claims, reconciles contradictions, prunes stale notes
   │  asks of each durable note: "would every future session in every project need this?"
   ▼
   ├─ in the canonical workbench (marker files: .claude-plugin/marketplace.json
   │  AND scripts/sync-global.ps1 both present) ─▶ promote: edit the canonical
   │  agent/skill file directly under plugins/<plugin>/{agents,skills}
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

Agents and skills are authored **directly in place** under `plugins/<plugin>/{agents,skills}/` — there is no build/generate step. Edit a file, and the next session that loads the plugin picks it up immediately.

This workbench dogfoods its own plugin: `.claude/settings.json` registers a marketplace named `skills-marketplace` pointing at the relative path `.` (`extraKnownMarketplaces`) and enables `conductor@skills-marketplace` (`enabledPlugins`). Because the marketplace source is this repo's own root, editing `plugins/conductor/agents/*.md` (or any skill under it) takes effect in this workbench's next session with no deploy step.

Two scripts under `scripts/` remain, for narrower jobs than before:

### `sync-global.ps1` — deploy settings.json to your machine

```powershell
pwsh scripts/sync-global.ps1
pwsh scripts/sync-global.ps1 -DryRun   # preview without applying
```

With agents and skills now authored in `plugins/` and installed as plugins, this script's only remaining job is syncing `.claude/settings.json` into `~/.claude/settings.json`:
- Repo-authoritative merge — the repo copy wins on everything, including deletions, except a small preserve-list of machine-local keys that survive from the deployed copy: `model`, `tui`, `enabledPlugins`, and `extraKnownMarketplaces` (the last is preserved because this repo's own settings.json registers its marketplace with the *relative* path `.`, which only resolves from this repo's own directory — the deployed/global value must win here instead).
- **Does not** register MCP servers — those now travel inside `plugins/conductor/.mcp.json`, delivered by the plugin itself.
- **Does not** touch `agent-memory/` (including `.obsidian/`) — the memory vault is project-local by design and entirely out of this script's scope now.

### `clean-global.ps1` — migrating a machine from the old sync-global to plugins

Plugin agents have the **lowest** name-resolution priority, so a `~/.claude/{agents,rules,skills}` copy left behind by an older version of `sync-global.ps1` (or a manual/zip copy) silently shadows the same-named `conductor` plugin agent forever — you'd install the plugin and still get the stale local copy. `clean-global.ps1` removes exactly that shadowing content, and nothing else:

```powershell
/plugin marketplace add <owner>/<repo>
/plugin install conductor@skills-marketplace
# ...install any other wanted plugins...

pwsh scripts/clean-global.ps1 -DryRun   # preview first
pwsh scripts/clean-global.ps1           # then run for real
```

Restart your Claude Code sessions afterward, and verify the plugin resolves: `claude --agent main` (or the scoped `conductor:main` if something still shadows it), and confirm the rules arrive via the preloaded `operating-standards` skill rather than a local `~/.claude/rules/` copy.

What it does and doesn't touch:
- **Backs up first, always** — before removing anything, it copies the current `~/.claude/{agents,rules,skills}` to a timestamped `~/.claude-backup-<timestamp>/`. Delete that backup once you're satisfied the migration worked.
- **Removes by name-match only** — an item under `~/.claude/{agents,rules,skills}` is removed only if its name matches something this repo actually ships. Canon agent and skill names are read live from `plugins/*/`; the two legacy rules filenames (`engineering-rules.md`, `git-hygiene.md`) no longer exist as files in this repo — they're absorbed into the `operating-standards` skill — so they're hardcoded in the script for matching purposes only. Foreign files/dirs (never part of this repo) are never touched.
- **Never touches `settings.json`** — the `permissions.deny` git-mutation guard and machine-local keys stay exactly as they are; plugins cannot ship `permissions.deny`, so this file must survive the migration untouched.
- **Never touches `agent-memory/`** — the memory vault is project-local and out of scope for this cleanup.

This workbench machine itself can keep using `sync-global.ps1` for day-to-day development (e.g. testing plugins locally via `claude --plugin-dir`) — migrating away from it is optional here, and only really matters for machines that consume the marketplace as plugins.

### `memory-lint.ps1` — deterministic vault linter

```powershell
pwsh scripts/memory-lint.ps1
pwsh scripts/memory-lint.ps1 -Fix   # safe, idempotent auto-repairs
```

Checks the `.claude/agent-memory/` vault for broken links (including wikilinks that don't match any note's declared `name:`), orphaned notes, tag sprawl outside the `type/*`/`agent/*` scaffold, expired or stale-and-orphaned notes, frontmatter schema mismatches, `MEMORY.md` index mismatches, and stray notes living outside the canonical folder structure. `STRAY-LOCATION` walks the project root (pruning `.git`, `releases`, `node_modules`) and identifies an agent-memory folder purely by the presence of a `MEMORY.md` file as a direct child — no plugin/agent name roster involved, so the check is rename-proof. A `MEMORY.md`-bearing directory that isn't the vault root itself and isn't a direct child of the vault root is flagged as stray. The walk is a manual, symlink-safe traversal (not `Get-ChildItem -Recurse`), so a cyclic symlink or junction can't cause an infinite loop. Exits non-zero on integrity errors. This check is read-only — it only detects and reports; `memory` (the memory subagent) owns integrating any strays it finds, canonical note taking precedence before the stray is pruned. `-Fix` applies safe, idempotent repairs (filename normalization, index rewrites, missing `metadata.updated`, tag format normalization) and regenerates `.obsidian/graph.json` color groups — one deterministic color per `topic/*` tag in use. `plugins/conductor/skills/memory-review/` is the companion judgment skill — run it for accuracy review against current repo state (monthly, or after major changes); it runs the linter first, then applies judgment the linter can't (verify, reconcile, prune, promote).

### Memory vault + Obsidian setup

`.claude/agent-memory/` is a per-subagent memory vault, browsable in Obsidian. Each subagent folder (`conductor-main/`, `conductor-implement/`, …) holds topic-slug notes with YAML frontmatter and wikilinks; cross-agent `[[links]]` resolve vault-wide. Frontmatter may optionally carry `freshness` (`timeless`/`slow`/`medium`/`fast`), `expires`, and `supersedes` — contradicted notes are invalidated and cross-linked to their replacement, never deleted out from under an inbound link. See the `memory-write` skill for the schema.

Each folder's `MEMORY.md` index auto-loads into that agent's context at spawn, but only the first **200 lines or 25KB, whichever comes first** — anything past that is silently dropped. Keep entries to one line each and push detail into the topic note it points to.

**Setup:**
1. Install [Obsidian](https://obsidian.md) → **Open → Open folder as vault** → select `.claude/agent-memory/` (the folder itself, not the repo root or a subagent folder).
2. **Settings → Files and links:** set **New link format** to `Shortest path when possible` and **Use Wikilinks: ON**, so bare `[[topic-slug]]` links resolve (filenames are unique vault-wide).
3. **Graph view** (⌘/Ctrl-G): enable **Filters → Tags** to turn `type/*`, `topic/*`, `agent/*` into hub nodes — `topic/*` is the cross-cutting connector linking subjects across agent folders. Use **Groups** to color-code by `path:<agent>` or `tag:#type/*` (list specific queries above broad ones — first match wins).
4. The **Tags** and **Properties** side panes browse the taxonomy and render `metadata.*` per note.
5. Optional: *Find Unlinked Files* / *Broken Links* community plugins for orphan/broken-link reports — `scripts/memory-lint.ps1` already does this deterministically.
6. If you don't want per-user Obsidian UI state committed, gitignore `.claude/agent-memory/.obsidian/`.

Memory is project-local by design — no script syncs `agent-memory/` to `~/.claude/`. Each project where you run the conductor gets its own vault.

---

## Reference

### Git Hygiene

Agents never mutate git state. Enforced by two layers:

1. **Rule** — the `operating-standards` skill (preloaded by every agent) instructs all agents to treat git as read-only.
2. **Deny list** — `permissions.deny` in `settings.json` hard-blocks mutating commands.

There is no `PreToolUse` hook backstop — the deny list is the sole deterministic enforcement layer, backed by the advisory rule.

`git status`, `diff`, `log`, `blame`, and `show` are allowed. Everything else in the deny list above is blocked — including the dual-mode subcommands (`branch`, `tag`, `stash`, `worktree`, `remote`, `notes`) **wholesale**, which also blocks their read-only listing forms (e.g. `git branch -a`, `git remote -v`). To inspect refs read-only, use `git for-each-ref` / `git show-ref` instead.

### MCP Servers

Shipped inside `plugins/conductor/.mcp.json`, delivered by the plugin itself. Verify connections inside a session with `/mcp`.

| Server | Purpose |
|--------|---------|
| `sequential-thinking` | Structured reasoning for planning and decomposition |
| `context7` | Up-to-date library and framework documentation |

### Versioning

Plugin entries in `.claude-plugin/marketplace.json` omit `version` deliberately — for git-source installs, every commit is a new floating version.
