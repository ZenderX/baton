# statusline

Claude Code statusline implementing design **6a — "Thin bars, cache in the grid"**: two lines of about 98 columns on one shared column grid.

```
ctx ━╸──────────────   9% 89k/1M  · cache expires in 59m    97% │ Opus 5.5  ▌the-conductor main +!
5h  ━━━╸────────────  22% 2h44m   · wk    ━━━━━━━━━━━━━╸──  84% · Fable ━━━━━━━━━━╸─────  66% 3d22h
```

## The grammar

The split follows what resets when. **Line one** is everything tied to this session — how full the context window is, the prompt cache, the model, repo and branch — and clears when you start a new conversation. **Line two** is your plan (`5h · wk · Fable`), which carries across conversations; it is omitted when none of the budgets has data. Both lines sit on a **fixed grid**, padded with spaces and measured in display cells: column 1 is 33 cols (label padded to 3, space, 16-cell bar, space, percentage right-aligned in 4, space, trailing value padded to 7) holding `ctx` over `5h`, so both bars start at column 5; then ` · `; column 2 is 27 cols (label padded to 5, space, a 16-col area, space, percentage right-aligned in 4) holding `cache` over `wk`, so the cache hit rate sits exactly above the `wk` percentage. Line one then continues ` │ ` + the **model** (bold, the brightest text on the line), two spaces, and the location group; line two continues ` · Fable` + bar + percentage + time to reset. The `│` on line one sits above the second `·` on line two. A cell with no data is filled with spaces (and the separator before it becomes spaces) when something follows it on the line, so the grid holds; trailing empty cells are dropped. Two weights of separator carry the structure: `│` divides groups and `·` separates items — no parentheses anywhere. Bars are **16 cells of thin glyphs read in half-cells** — `━` full, `╸` half, `─` empty track — **= 3.1% resolution**; thin strokes leave a gap between the lines, so stacked bars never merge. Every bar is followed by its percentage in the bar's own colour, so figure and shape can never disagree, then the trailing value — tokens against the window, or time left in the period.

| Item | Bar (spent) | Trailing value | Source |
|---|---|---|---|
| `ctx` | context used % | `used/window` tokens | live `max_model_len` from a local server (private host); payload `context_window` (matches `/context`); transcript+model-family fallback |
| `cache` | — (TTL text in the bar's place: `expires in 59m` / `expired`) | hit % | payload `prompt_cache` (v2.1.251+); transcript usages when the block is absent |
| model | — | — | payload `model.display_name`; the served model id from a local server (private host) |
| `5h` | session window % | time until reset (`2h44m`, `18m`) | OAuth usage endpoint, 60s cache |
| `wk` | weekly all-models % | — | 〃 |
| `Fable` | weekly model-scoped % | time until reset (`3d22h`) | 〃 |

Colour is derived, never decorative. Spent budgets (`ctx`, `5h`, `wk`, `Fable`): green below 60%, **amber 60–84%**, **bold red at 85%+** — the percentage always takes the bar's colour. The column-1 trailing values (`89k/1M`, `2h44m`) are neutral, bold red at 85%+; the `Fable` countdown is always dim. The `cache` is not a spent budget, so it gets no bar and stays off the green/amber/red scale: the TTL `expires in 59m` is dim grey, **amber bold at 5 minutes or less**, and `expired` is amber bold with the hit rate shown as `—`; the hit rate is neutral, amber only below 70%. The model name is plain text, no brackets, bold near-white. Location group: `▌` accent bar, dir (repo basename), bold purple branch, amber git flags `+!?$` (staged/modified/untracked/stash) — reactive per render. Padding spaces sit outside the colour escapes.

Palette (truecolor): accent bar `#2E6BAA`, dir `#9FC7EE`, branch `#B392E0`, flags/amber `#E2A63C`, empty track `#3A414B`, group sep `#4A5058`, item sep `#3F444D`, model `#E6E9EE` bold, neutral values `#A7ADB8`, labels `#757B87`, dim values `#5A606B`, green `#63BE8B`, red `#E0563F`.

## Local servers (OpenAI-compatible)

Works with local models behind an OpenAI-compatible proxy (e.g. `ANTHROPIC_BASE_URL=http://127.0.0.1:8080`), not just Claude's models. When `ANTHROPIC_BASE_URL` points at a **private host** (`localhost`, `::1`, `127.*`, `10.*`, `192.168.*`, `172.16–31.*`), two groups switch to local-server sources:

- **Context gauge denominator — live window.** The script probes `GET {base}/v1/models` (then `{base}/models`; a trailing `/v1` on the base is stripped first so it never hits `/v1/v1/models`) and reads `data[].max_model_len`, cached 60s in `~/.claude/.statusline-window.json`. Precedence: **live server value (private host only) → payload `context_window_size` → model-family map → default**. For local servers the window the server actually reports is the truth — a local `--max-context 120000` beats any static figure. Any fetch/parse failure falls through silently to the next source.
- **Cache group — transcript-derived.** When the payload carries no `prompt_cache` block (older Claude Code, or local models), the `cache` cell is derived from the session transcript's assistant usages: the last usage's hit rate `cache_read / (input + cache_read + cache_creation)`, with the TTL area left blank. Hidden until the last usage has a positive denominator.

**Real data only.** Nothing added here is estimated or invented — every figure is measured in-session or server-reported. No cache TTL or countdown is shown for local servers because the server exposes no cache state; the payload-reported `expires in 47m` in the `prompt_cache` cell is harness-reported data and is kept as-is.

## Install / lifecycle — automatic

Enabling and disabling the plugin (`/plugin`) is the whole lifecycle; global scope (`~/.claude/settings.json`):

- **Activate** → `SessionStart` + `UserPromptSubmit` hooks (`scripts/ensure-statusline.sh`, idempotent no-op in ~130ms, silent) write the `statusLine` block — `command` pointing at `scripts/statusline.sh`, `refreshInterval: 60` (undocumented but supported: re-runs the script every 60s while idle, keeping git flags and countdowns live). Claude Code watches `statusLine` in settings live, so after enabling (run `/reload-plugins` if prompted), the statusline appears on your **next message** — no restart.
- **Deactivate** → on its next render tick the script detects the plugin is no longer enabled (`enabledPlugins` key `statusline@*` absent/false), deletes its own `statusLine` block from settings (jq-validated write, other keys preserved), and renders nothing. Re-enabling re-wires it at next session start.

`/statusline:setup` still exists as a manual fallback (e.g. to wire it immediately without restarting).

## Requirements

- Bash (Git Bash on Windows, or macOS — the script probes GNU `date`/`stat` and falls back to BSD)
- `jq`, `curl`
- Truecolor terminal (Windows Terminal is). **No Nerd Font needed** — `━ ╸ ─ ▌ │ · —` are standard Unicode, one cell wide.
- Claude Code OAuth login for the plan-usage gauges. Token is read from `~/.claude/.credentials.json` when present (Windows/Linux), otherwise from the macOS login Keychain (`Claude Code-credentials`).
- Optional: a local OpenAI-compatible server via `ANTHROPIC_BASE_URL` (private host) for the live context window and the transcript-derived cache group.

## Caveats

- The plan-usage endpoint (`/api/oauth/usage`) is internal Claude Code plumbing — if its shape changes, those gauges drop off silently; fix is a small `jq` tweak in `scripts/statusline.sh`.
- Avoid double-width glyphs (emoji, `⟳`) in the script's output: Windows Terminal renders them two cells wide but advances one, corrupting adjacent text.
- Segments degrade gracefully: non-git dir drops branch/flags; missing plan data drops line two (single line, still on the grid); a missing `ctx` or `cache` cell is blanked to spaces so the `│` group keeps its column; a missing model starts the `│` group at the location.
- The local-server window probe only fires for private hosts (never a public API) and fails soft: a dead proxy just drops back to the model-family window after the two 4s curl timeouts of a 60s cache cycle.
- The hook also sets `env.MSYS = "error_start:"` in settings. Refreshing every 60s forks bash heavily, and on Windows a fork that dies at startup (address-space collision) makes MSYS2 dump a `bash.exe.stackdump` file into the cwd — i.e. your repo root ([anthropics/claude-code#37920](https://github.com/anthropics/claude-code/issues/37920)). `error_start:` with an empty value suppresses only that file; errors are still reported normally.
