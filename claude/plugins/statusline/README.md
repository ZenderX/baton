# statusline

Claude Code statusline implementing design **8a — "Identity line, then the 6a grid"**: 3 lines — an identity line, then two lines on one shared column grid, at most 102 columns (line three with a 6-char `Fable` countdown such as `90d16h`; line one is unpadded and as long as its names).

```
▌the-conductor main +!? · Opus 5.5
ctx   ━╸──────────────   9% 89k/1M  · cache expires in 59m    97% · out   1.2k
5h    ━━━╸────────────  22% 2h44m   · wk    ━━━━━━━━━━━━━╸──  84% · Fable ━━━━━━━━━━╸─────  66% 3d22h
```

On usage credit (see [Usage credit](#usage-credit)) line three becomes the session cost and the `out` cell moves to it:

```
▌the-conductor main +!? · Opus 5.5
ctx   ━╸──────────────   9% 89k/1M  · cache expires in 59m    97%
cost  ━───────────────   6% $3.14   · out   1.2k
```

## The grammar

**Line one** is identity, left-aligned and unpadded: `▌`, the folder, the branch, the git status flags, ` · `, then the **model** (bold, the brightest text on the line). The other two lines follow what resets when. **Line two** is this conversation — how full the context window is, the prompt cache, and the last API response's output tokens — and clears when you start a new one. **Line three** is your plan (`5h · wk · Fable`), which carries across conversations; on usage credit it is `cost · out` instead. A grid line with no data at all is omitted. Lines two and three sit on a **fixed grid**, padded with spaces and measured in display cells: column 1 is 35 cols (label padded to 5, space, 16-cell bar, space, percentage right-aligned in 4, space, trailing value padded to 7) holding `ctx` over `5h`; then ` · `; column 2 is 27 cols (label padded to 5, space, a 16-col area, space, percentage right-aligned in 4) holding `cache` over `wk`. Every label is padded to five cells to match `cache`, so every bar starts at column 7; the cache TTL text is padded to the 16-col bar width before the hit rate, so the hit rate ends exactly above the `wk` percentage (column 65) whatever the TTL says. Line three continues ` · Fable` + bar + percentage + time to reset. After column 2 comes ` · out` (label padded to 5, space, count) — on line two in plan mode, on line three after the `cost` gauge in credit mode. A cell with no data is filled with spaces (and the separator before it becomes spaces) when something follows it on the line, so the grid holds; trailing empty cells are dropped. `·` separates items — no parentheses anywhere. Bars are **16 cells of thin glyphs read in half-cells** — `━` full, `╸` half, `─` empty track — **= 3.1% resolution**; thin strokes leave a gap between the lines, so stacked bars never merge. Every bar is followed by its percentage in the bar's own colour, so figure and shape can never disagree, then the trailing value — tokens against the window, time left in the period, or dollars spent. Percentages may arrive non-integer (`22.5`); the gauge truncates toward zero, so `99.9` never reads as a full bar. The `ctx` trailing value is `used/window` (`89k/1M`) when that fits its 7 cols; otherwise it is `used` alone (`150k` on a 200k window, `50k` on 110k), since the percentage already carries the ratio. Nothing is truncated mid-number, so the grid holds for every window size.

| Item | Bar (spent) | Trailing value | Source |
|---|---|---|---|
| `ctx` | context used % | `used/window` tokens (`used` alone past 7 cols) | live `max_model_len` from a local server (private host); payload `context_window` (matches `/context`); transcript+model-family fallback |
| `cache` | — (TTL text in the bar's place: `expires in 59m` / `expired`) | hit % | payload `prompt_cache` (v2.1.251+); transcript usages when the block is absent |
| `out` | — | output tokens (`1.2k`) | payload `context_window.total_output_tokens`: the most recent API response's output, not a session total. Dropped when absent/null, and while `current_usage` is null and `total_input_tokens` and `total_output_tokens` are both 0, i.e. before the first API response |
| model | — | — | payload `model.display_name`; the served model id from a local server (private host) |
| `5h` | session window % | time until reset (`2h44m`, `18m`) | OAuth usage endpoint, 60s cache |
| `wk` | weekly all-models % | — | 〃 |
| `Fable` | weekly model-scoped % | time until reset (`3d22h`) | 〃 |
| `cost` (credit mode only) | session cost against a $50 scale (`STATUSLINE_CREDIT_SCALE_USD`); shown up to `999%` | `$3.14` (2 decimals; whole dollars like `$1235` past 7 cols) | payload `cost.total_cost_usd`; dropped when absent/null |

Colour is derived, never decorative. Spent budgets (`ctx`, `5h`, `wk`, `Fable`, `cost`): green below 60%, **amber 60–84%**, **bold red at 85%+** — the percentage always takes the bar's colour. The column-1 trailing values (`89k/1M`, `2h44m`, `$3.14`) are neutral, bold red at 85%+; the `Fable` countdown is always dim; the `out` count is neutral. The `cache` is not a spent budget, so it gets no bar and stays off the green/amber/red scale: the TTL `expires in 59m` is dim grey, **amber bold at 5 minutes or less**, and `expired` is amber bold with the hit rate shown as `—`; the hit rate is neutral, amber only below 70%. The model name is plain text, no brackets, bold near-white. Identity line: `▌` accent bar, dir (repo basename), bold purple branch, amber git flags `+!?$` (staged/modified/untracked/stash) — reactive per render. Padding spaces sit outside the colour escapes.

Palette (truecolor): accent bar `#2E6BAA`, dir `#9FC7EE`, branch `#B392E0`, flags/amber `#E2A63C`, empty track `#3A414B`, item sep `#3F444D`, model `#ECE9E2` bold, neutral values `#A7ADB8`, labels `#757B87`, dim values `#5A606B`, green `#63BE8B`, red `#E0563F`.

## Usage credit

Plan usage is consumed first; usage credits are drawn only after a plan limit is hit. The script switches line three to credit mode when the cached OAuth usage response has `extra_usage.is_enabled == true` **and** either

- a plan window is at or above 100% — endpoint `limits[].percent`, legacy `five_hour`/`seven_day` `utilization`, or the payload's `rate_limits.five_hour`/`seven_day` `used_percentage`, each truncated toward zero (`99.9` does not trigger, `100.0` does) — or
- no plan window exists in either source (the response has no `limits[]` percent and no legacy windows, and the payload has no `rate_limits`).

No usage response (no credentials, offline, Enterprise), no `extra_usage` object, or `is_enabled` false/null means plan mode: line three is `5h · wk · Fable` and shows no `$`. In credit mode line three is `cost · out`, and `out` leaves line two.

The dollar figure is `cost.total_cost_usd` as Claude Code reports it: its own client-side session total at list price, including foreground subagent requests, reset on `/clear`. It is not your credit balance or invoice. Whether background (`run_in_background`) subagents reach it is unverified; the script does not compensate.

## Environment

| Variable | Effect |
|---|---|
| `STATUSLINE_CREDIT_SCALE_USD` | Dollar amount that fills the `cost` bar (default `50`). Must be a positive number; empty or invalid falls back to 50. |
| `ANTHROPIC_BASE_URL` | On a private host, enables the local-server sources below. |
| `CLAUDE_CONTEXT_WINDOW` | Window size used by the model-family fallback when neither a local server nor the payload reports one. |

There is no separate offline override for the usage response: a `~/.claude/.statusline-usage.json` younger than 60s is read without a fetch (run under a temporary `HOME` to feed a fixture). A fetched response replaces that cache only when it carries `limits`, `extra_usage` or the legacy windows, so an error body never overwrites a good cache.

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
- Truecolor terminal (Windows Terminal is). **No Nerd Font needed** — `━ ╸ ─ ▌ · —` are standard Unicode, one cell wide.
- Claude Code OAuth login for the plan-usage gauges and credit mode. Token is read from `~/.claude/.credentials.json` when present (Windows/Linux), otherwise from the macOS login Keychain (`Claude Code-credentials`).
- Optional: a local OpenAI-compatible server via `ANTHROPIC_BASE_URL` (private host) for the live context window and the transcript-derived cache group.

## Caveats

- The plan-usage endpoint (`/api/oauth/usage`) is internal Claude Code plumbing — if its shape changes, those gauges drop off silently; fix is a small `jq` tweak in `scripts/statusline.sh`.
- Avoid double-width glyphs (emoji, `⟳`) in the script's output: Windows Terminal renders them two cells wide but advances one, corrupting adjacent text.
- Segments degrade gracefully: non-git dir drops branch/flags from line one; a missing model drops its ` · `; missing plan data drops line three; a missing `ctx` cell before `cache` is blanked to spaces so `cache` keeps its column; a grid line with no data is omitted.
- The local-server window probe only fires for private hosts (never a public API) and fails soft: a dead proxy just drops back to the model-family window after the two 4s curl timeouts of a 60s cache cycle.
- The hook also sets `env.MSYS = "error_start:"` in settings. Refreshing every 60s forks bash heavily, and on Windows a fork that dies at startup (address-space collision) makes MSYS2 dump a `bash.exe.stackdump` file into the cwd — i.e. your repo root ([anthropics/claude-code#37920](https://github.com/anthropics/claude-code/issues/37920)). `error_start:` with an empty value suppresses only that file; errors are still reported normally.
