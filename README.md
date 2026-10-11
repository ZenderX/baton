# baton

[![CI](https://img.shields.io/github/actions/workflow/status/ZenderX/baton/ci.yml?branch=main&label=CI)](https://github.com/ZenderX/baton/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Claude Code plugin](https://img.shields.io/badge/Claude_Code-plugin-D97757)](#install--launch-claude-code)
[![pi package](https://img.shields.io/badge/pi-package-5A67D8)](#install--launch-pi)

AI agent orchestration for Claude Code and pi, from one source tree, with no build step.

## What it does

You give an orchestrator a coding task. It writes a plan, splits the work into steps, and hands each step to a specialist agent. Finished work is checked and sent back for fixes until it passes. The orchestrator is the only agent that talks to you.

Two products share one core, called baton, and can be installed side by side:

- **conductor**: an orchestrator with four agents (planning, research, implement, code-review). It plans the job, builds it, then reviews it.
- **refuter**: an orchestrator with five agents (scout, architect, developer, tester, expert). Each step is built, then challenged by a tester until it holds up.

Also included: a statusline, and skills (short guides the agents load when relevant) for Bevy, Blender, Rust, TypeScript and Vue 3.

## Install

Follow the steps for your harness.

### Install & launch (pi)

Install the clone's `pi/` folder. It is one pi package that loads the core, both products and the context7 MCP server (a documentation lookup tool for the agents, named `pi-baton__context7_<tool>` in pi):

```bash
git clone https://github.com/ZenderX/baton.git
pi install /absolute/path/to/baton/pi
pi --conductor --model <provider/model>    # or: pi --refuter
```

To load only one product, replace that package with an entry in the `packages` list of pi's settings that filters out the other, for example:

```json
{ "source": "/absolute/path/to/baton/pi", "extensions": ["!refuter/**"], "prompts": ["!refuter/**"] }
```

### Install & launch (Claude Code)

Add the marketplace (or run `/plugin marketplace add ZenderX/baton` inside Claude Code), then install and launch:

```bash
claude plugin marketplace add ZenderX/baton
claude plugin install conductor@baton      # and/or: refuter@baton
claude --agent baton:conductor             # or: claude --agent baton:refuter
```

From a clone, add the clone's root folder instead: `claude plugin marketplace add /absolute/path/to/baton`.

## Repository layout

| Path | What is inside |
|---|---|
| `claude/` | The Claude Code plugins: orchestrators, agents, hooks and the statusline |
| `pi/` | The pi package: the shared engine in `pi/core`, plus `pi/conductor` and `pi/refuter` |
| `claude/plugins/*/skills/` | The skills, written once and read by both Claude Code and pi |
| `docs/` | [`job-files.md`](docs/job-files.md), the protocol agents use to hand work to each other |
| `scripts/` | Repository tooling (PowerShell 7) |

## Contributing

- Agent prompts exist twice, once for Claude Code and once for pi. Change both copies together.
- Typecheck the pi code with `npx --prefix pi tsc -p pi/tsconfig.json` (run `npm --prefix pi install` once first).
- Markdown files use CRLF line endings, enforced by `.gitattributes`.
- Pull requests are welcome. The maintainer applies accepted changes rather than merging them on GitHub.

## License

MIT, see [LICENSE](LICENSE).
