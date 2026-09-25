# statusline

Claude Code statusline implementing design **2a — "Gauges, tightened: two separator weights, percentage on every budget"**.

```
▌my-project develop !?$ │ Fable 5 ██▌░░░ 40% 397k/1M · cache █ 91% (47m) 2 miss │ 5h ████░░ 70% 3h03m · wk █░░░░░ 20% · Fable ██░░░░ 31% 4d2h
```

## The grammar

Two weights of separator carry the structure: `│` divides the three groups — **where you are** · **what you're talking to and how full it is** · **what you have left** — and `·` separates items inside the budget group. Each bar is **six cells read in half-cells (`▌`) = 8.3% resolution**. Every bar is followed by its percentage in the bar's own colour, so figure and shape can never disagree; the dim trailing value is the thing that counts down.

| Item | Bar (spent) | Trailing value | Source |
|---|---|---|---|
| model + ctx | context used % | `used/window` tokens | live `max_model_len` from a local server (private host); payload `context_window` (matches `/context`); transcript+model-family fallback |
| `cache` | — (warm █ / cold ░) | hit %, time until cold, misses | payload `prompt_cache` (v2.1.251+); transcript usages when the block is absent |
| `5h` | session window % | time until reset, right-aligned to 5 (`  18m` at crunch) | OAuth usage endpoint, 60s cache |
| `wk` | weekly all-models % | — | 〃 |
| `Fable` | weekly model-scoped % | time until reset | 〃 |

Colour is derived, never decorative: green, **amber past 60%**, **red past 85%** — the percentage goes bold red at red; time-critical countdowns go bold red too, token figures only brighten. The `cache` item inverts this: hit ratio is good when high, so green **>=85%**, amber **>=60%**, red **below 60%**. Left group: `▌` accent bar, dir (repo basename), bold branch, git flags `+!?$` (staged/modified/untracked/stash) — reactive per render.

Palette (truecolor): bar `#2E6BAA`, dir `#9FC7EE`, branch `#B392E0`, flags/amber `#E2A63C`, empty cells `#343A43`, group sep `#4A5058`, item sep `#3F444D`, model/bright values `#A7ADB8`, labels `#757B87`, dim values `#5A606B`, green `#63BE8B`, red `#E0563F`.

## Local servers (OpenAI-compatible)

Works with local models behind an OpenAI-compatible proxy (e.g. `ANTHROPIC_BASE_URL=http://127.0.0.1:8080`), not just Claude's models. When `ANTHROPIC_BASE_URL` points at a **private host** (`localhost`, `::1`, `127.*`, `10.*`, `192.168.*`, `172.16–31.*`), two groups switch to local-server sources:

- **Context gauge denominator — live window.** The script probes `GET {base}/v1/models` (then `{base}/models`; a trailing `/v1` on the base is stripped first so it never hits `/v1/v1/models`) and reads `data[].max_model_len`, cached 60s in `~/.claude/.statusline-window.json`. Precedence: **live server value (private host only) → payload `context_window_size` → model-family map → default**. For local servers the window the server actually reports is the truth — a local `--max-context 120000` beats any static figure. Any fetch/parse failure falls through silently to the next source.
- **Cache group — transcript-derived.** When the payload carries no `prompt_cache` block (older Claude Code, or local models), the group is derived from the session transcript's assistant usages: the last usage's hit rate `cache_read / (input + cache_read + cache_creation)` and a session miss counter (usages carrying cache fields with `cache_read == 0`, shown only when > 0). Hidden until the last usage has a positive denominator.

**Real data only.** Nothing added here is estimated or invented — every figure is measured in-session or server-reported. No cache TTL or countdown is shown for local servers because the server exposes no cache state; the payload-reported `(47m)` expires in the `prompt_cache` group is harness-reported data and is kept as-is.

## Install / lifecycle — automatic

Enabling and disabling the plugin (`/plugin`) is the whole lifecycle; global scope (`~/.claude/settings.json`):

- **Activate** → `SessionStart` + `UserPromptSubmit` hooks (`scripts/ensure-statusline.sh`, idempotent no-op in ~130ms, silent) write the `statusLine` block — `command` pointing at `scripts/statusline.sh`, `refreshInterval: 60` (undocumented but supported: re-runs the script every 60s while idle, keeping git flags and countdowns live). Claude Code watches `statusLine` in settings live, so after enabling (run `/reload-plugins` if prompted), the statusline appears on your **next message** — no restart.
- **Deactivate** → on its next render tick the script detects the plugin is no longer enabled (`enabledPlugins` key `statusline@*` absent/false), deletes its own `statusLine` block from settings (jq-validated write, other keys preserved), and renders nothing. Re-enabling re-wires it at next session start.

`/statusline:setup` still exists as a manual fallback (e.g. to wire it immediately without restarting).

## Requirements

- Bash (Git Bash on Windows, or macOS — the script probes GNU `date`/`stat` and falls back to BSD)
- `jq`, `curl`
- Truecolor terminal (Windows Terminal is). **No Nerd Font needed** — `▌ █ ░ │` are standard Unicode.
- Claude Code OAuth login for the plan-usage gauges. Token is read from `~/.claude/.credentials.json` when present (Windows/Linux), otherwise from the macOS login Keychain (`Claude Code-credentials`).
- Optional: a local OpenAI-compatible server via `ANTHROPIC_BASE_URL` (private host) for the live context window and the transcript-derived cache group.

## Caveats

- The plan-usage endpoint (`/api/oauth/usage`) is internal Claude Code plumbing — if its shape changes, those gauges drop off silently; fix is a small `jq` tweak in `scripts/statusline.sh`.
- Avoid double-width glyphs (emoji, `⟳`) in the script's output: Windows Terminal renders them two cells wide but advances one, corrupting adjacent text.
- Segments degrade gracefully: non-git dir drops branch/flags; missing plan data drops those gauges; missing context data drops `ctx`.
- The local-server window probe only fires for private hosts (never a public API) and fails soft: a dead proxy just drops back to the model-family window after the two 4s curl timeouts of a 60s cache cycle.
- The hook also sets `env.MSYS = "error_start:"` in settings. Refreshing every 60s forks bash heavily, and on Windows a fork that dies at startup (address-space collision) makes MSYS2 dump a `bash.exe.stackdump` file into the cwd — i.e. your repo root ([anthropics/claude-code#37920](https://github.com/anthropics/claude-code/issues/37920)). `error_start:` with an empty value suppresses only that file; errors are still reported normally.
