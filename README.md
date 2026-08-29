# Skills Marketplace

Private marketplace of Claude Code plugins: the **conductor** agent (orchestrator + 5 subagents) and its domain skills (Bevy, Blender, Rust, TypeScript, Vue 3).

Everything lives in this folder. There is nothing left to synchronize: when this folder changes, your agents are up to date in **all** your projects at the next Claude restart.

---

## Installation

1. **Update Claude Code** (recommended before anything else):

   ```bash
   claude --upgrade
   ```

2. **Put this folder** somewhere permanent — you will not be able to move it afterwards without reconfiguring the marketplace.

3. **Add the marketplace.** Start Claude, then run the `/plugin` command:

   ```bash
   claude
   ```

   ```
   /plugin
   ```

   Choose **Add Marketplace**, then give the path to **this folder** (the one containing this README).

4. **Close Claude** once the marketplace is added.

5. **Always start your sessions with the conductor**:

   ```bash
   claude --agent conductor:main
   ```

6. **Enable the plugins.** In a session, run `/plugin` again to choose the skills you want to enable. Everything should be enabled by default — you can disable whatever is irrelevant to your project.

---

## The plugins

| Plugin | Description |
|---|---|
| `conductor` | Conductor orchestrator + 5 subagents (planning, research, implement, code-review, memory) with their preloaded skills and MCP servers. |
| `bevy` | Bevy 0.19.1 ECS conventions, plugin architecture and gameplay patterns. For writing or reviewing Bevy game code. |
| `blender` | Blender → Bevy workflow conventions with bevy_skein 0.5. For code that integrates with Blender or uses bevy_skein. |
| `rust` | Rust coding standards and conventions. For writing or reviewing Rust files. |
| `typescript` | TypeScript coding standards. For writing or reviewing TypeScript or TSX files. |
| `vue3` | Vue 3 coding standards with Composition API, Pinia and TypeScript. For writing or reviewing `.vue` files and their associated composables. |

---

## pi (coding agent)

The same folder also serves as a **pi package**: the conductor, its 5 subagents and the domain skills are loaded as-is, without copying.

### Prerequisites

- **Node.js ≥ 20** (tested on 24).
- **pi ≥ 0.84.3**:

  ```bash
  npm install -g @earendil-works/pi-coding-agent
  pi --version
  ```

In the commands below, replace `<absolute-repo-path>` with the path to this folder — for example `/absolute/path/to/baton`.

### Model providers

**Anthropic** — run `pi`, then `/login` (or `pi auth` outside a session). Third-party applications draw on *extra usage*, not on your subscription quota.

**LM Studio** — start LM Studio's *Local Server* (`http://127.0.0.1:1234`), load a model, then install the provider:

```bash
pi install npm:pi-lmstudio
pi --list-models lmstudio
```

Models show up as `lmstudio/<key>`, for example `lmstudio/example-27b@q4_k_m`.

### Installation

```bash
pi install <absolute-repo-path>   # global, all projects
pi list                           # check
pi remove <absolute-repo-path>    # uninstall
```

The path is stored as a relative path in `~/.pi/agent/settings.json`. A `.pi/settings.json` (`{"packages": ["../"]}`) is provided for development from this folder: paths there are relative to `.pi/`, so `../` points at the repo root. It requires the project to be trusted (`/trust` interactively, `--approve` otherwise). The global install is enough in most cases — the two are deduplicated by absolute path.

### First run

1. Move into any project (`cd`).
2. Start pi on a model:

   ```bash
   pi --model lmstudio/example-27b@q4_k_m
   ```

3. Enable the orchestrator and give it a task:

   ```
   /conductor Describe this repository in three lines
   ```

4. Watch the `subagent` tool calls in the output.
5. Leave the mode with `/conductor off`.

Variants: `pi --conductor` starts directly in orchestrator mode, `pi --conductor -p "my task"` does it without interaction. Without the mode, you can call an agent directly by asking the model: *Use the `subagent` tool with the `code-review` agent and the task "…"*.

### Usage

`/conductor [task]` enables the mode and dispatches, `/conductor off` disables it; the state survives a `--resume`. The `subagent` tool dispatches one agent (`{agent, task}`), several in parallel (`tasks[]`, max 8, 4 concurrent) or chained (`chain[]` with `{previous}`).

The 5 agents — `planning`, `research`, `implement`, `code-review`, `memory` — pin no model: each child inherits the model of the session that dispatches it (the one from `pi --model <provider/id>`), along with its thinking level when the agent declares none. Only `planning` (`thinking: high`) and `implement` (`thinking: medium`) declare one. Two environment variables redirect **all** children:

```powershell
$env:PI_CONDUCTOR_MODEL="lmstudio/<model>"   # provider/id
$env:PI_CONDUCTOR_THINKING="high"            # off|minimal|low|medium|high|xhigh|max
```

```bash
PI_CONDUCTOR_MODEL=lmstudio/<model> PI_CONDUCTOR_THINKING=high pi --conductor
```

For per-agent tiering, add a `model: <provider/id>` line in a user override agent (`~/.pi/agent/agents/<name>.md`) or project one (`.pi/agents/<name>.md`): this pin wins over inheritance, and the variables above win over it.

Workers (`planning`, `research`, `implement`, `code-review`) declare `spawn: [memory]` in their frontmatter: they keep the `subagent` tool and use it to call the `memory` agent directly when they learn something durable. A child may only dispatch the agents in its own `spawn:` list, exported to it as `PI_CONDUCTOR_SPAWN_ALLOW`; anything else comes back as an error. `memory` declares no list, so nesting stops there — as does any agent without a `spawn:` line, which has no `subagent` tool at all.

`sequential_thinking` is a native reimplementation of the upstream MCP tool inside the conductor extension, same parameters, with per-session in-memory state. It's named in the pinned `tools:` of `planning`, `research`, and `code-review`; `memory` doesn't pin it, matching Claude's memory agent, which never grants it either. `implement` pins no `tools:` line, so it inherits the tool too.

`/statusline` (or `--statusline`) displays a footer: folder + branch, model + context bar, tokens and cost.

### Development

```
pi/extensions/conductor/{index,agents,orchestrator}.ts + orchestrator.md
pi/extensions/statusline.ts
pi/extensions/lmstudio-reasoning.ts
pi/agents/*.md
pi/prompts/conductor.md
```

Skills are served in place from `plugins/*/skills`. After any edit under `pi/`, run `/reload` in the session.

To load the extension alone, without the manifest:

```bash
pi -e ./pi/extensions/conductor/index.ts
```

The manifest skills are then not loaded, but children still receive their `--skill`. Optional typecheck:

```bash
npm install
npx tsc -p pi/tsconfig.json
```

### Troubleshooting

- **`No API key found for anthropic`** — an override agent pins a provider without credentials. The package now falls back to the session model with a warning; otherwise, set `PI_CONDUCTOR_MODEL`.
- **`Reasoning setting 'medium' is not supported … Falling back to 'on'`** — with an LM Studio backend, models whose reasoning is only `on`/`off` still receive pi's graded `reasoning_effort`: `lmstudio-reasoning.ts` strips that field automatically, which removes the server-side warning. Never rewrite the value to `on`: the server answers 400.
- **27B model too slow** — set `PI_CONDUCTOR_THINKING=off` and target the lightest agent for smoke tests.
- **Unknown `-m`** — the option is `--model`, not `-m`.
- **`.pi/` resources ignored by children** — the parent project must be approved; `--approve` is then passed automatically.

### Filtering resources

Object form in `packages` to load only part of the package:

```json
{
  "packages": [
    {
      "source": "<absolute-repo-path>",
      "skills": ["plugins/rust/skills", "plugins/typescript/skills"],
      "prompts": []
    }
  ]
}
```

Omitting a key loads everything of that type; `[]` loads none; `!pattern` excludes.

### Not ported

MCP (context7) — pi has no MCP; the statusline's plan-usage segment; `TaskCreate`; the `permissions.deny` guardrails, now plain prompt instructions.

---

## Memory

The conductor keeps a memory *vault* per project, in:

```
.claude/agent-memory/conductor-main/
```

These are Markdown files with wikilinks — you can open the folder as an **Obsidian** vault to browse it visually.

For now this memory mostly serves the agent itself. You have nothing to write in it by hand. Notes are written by the `memory` subagent, which every conductor worker calls directly when it learns something durable; `MEMORY.md` reaches the orchestrator through its `memory: project` setting (Claude Code) or inlined in its runtime block (pi).

---

## Migrating from the old setup

If you were using the old version with file synchronization, clean up — otherwise you will end up with duplicate agents and rules.

1. **Clean the old global folders** in your `~/.claude` (`C:\Users\<you>\.claude` on Windows) with the provided script. It backs up before deleting, refuses to touch symlinks, and only removes files that come from this repository — your `settings.json`, `agent-memory/`, `plugins/` and any personal content are preserved.

   Start with a dry run to see what would be touched:

   ```bash
   pwsh scripts/clean-global.ps1 -DryRun
   ```

   Then, if the result suits you, run the real cleanup:

   ```bash
   pwsh scripts/clean-global.ps1
   ```

   > The script requires **PowerShell 7 (`pwsh`)** — `powershell.exe` (5.1) is not supported.

2. **Clean each of your projects** — remove the `.claude/` and the `.mcp.json` that came from the old setup:

   ```bash
   rm -rf .claude .mcp.json
   ```

   > Warning: if a project already has a memory vault in `.claude/agent-memory/`, keep it and delete only the rest of the `.claude/`.

3. **Migrate your memory.** Open a conductor session in the project and run the review:

   ```bash
   claude --agent conductor:main
   ```

   ```
   /memory-review
   ```

   This migrates any stray `.claude/agent-memory/*` folder into the canonical `conductor-main/`.

---

## Updates

Editing this folder is enough: no synchronization, no copying. Restart Claude and the changes are active everywhere.

The `releases/` folder contains versioned archives corresponding to snapshots of this marketplace. The names follow two distinct series (`_cc_` and `_ghc_`) whose numbers are not comparable with each other. After a `git clone`, the modification date of the files matches the clone date and says nothing about their age: ask git history for the date to spot the most recent one.

```bash
git log -1 --format=%ad -- releases/<file>
```
