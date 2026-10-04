#!/bin/bash
# Claude Code statusline — design "8a: Identity line, then the 6a grid"
# 3 lines, at most 101 columns:
#   ▌dir branch +! · Opus 5.5
#   ctx   ━╸──────────────   9% 89k/1M  · cache expires in 59m    97%
#   5h    ━━━╸────────────  22% 2h44m   · wk    ━━━━━━━━━━━━━╸──  84% · Fable ━━━━━━━━━━╸─────  66% 3d22h
# Line 1 is identity (repo, branch, git flags, model), unpadded. Line 2 is
# this conversation (context window, prompt cache) and clears with a new one;
# line 3 is the plan budgets (5h · wk · Fable), which carry across
# conversations. A grid line with no data is omitted. Lines 2–3 share a fixed
# grid: column 1 (35 cols: label 5, bar 16, pct 4, tail 7), " · ", column 2
# (27 cols: label 5, 16-col area, pct 4), so every bar starts at column 7 and
# the cache % ends above the wk %. A missing cell is filled with spaces to
# keep the grid; trailing missing cells are dropped.
# Bars are 16 cells of thin glyphs read in half-cells (━ full, ╸ half,
# ─ empty track) = 3.1% resolution. Every bar is followed by its percentage in
# the bar's own colour, then the trailing value (tokens against the window,
# time left in period; wk has none). The ctx tail is used/window (89k/1M) when
# that fits its 7 cols, else used alone (150k of 200k): never truncated, and
# the grid holds for every window. Colour derived: green under 60%, amber
# past 60%, bold red past 85%. Column-1 tails are neutral, bold red past 85%;
# the Fable countdown is always dim. The cache is not a spent budget: no bar,
# TTL dim (amber bold at <=5 min or expired), hit rate neutral (amber <70%).
# Reactive: settings.json statusLine.refreshInterval=60 re-runs this every
# minute even when idle. Reads Claude Code's JSON payload on stdin. Plan usage
# from the OAuth usage endpoint (same source as /usage), cached 60s in
# ~/.claude/.
# Local servers: ANTHROPIC_BASE_URL on a private host switches the gauge
# denominator to the window the server reports (GET /v1/models, 60s cache) and
# derives the cache group from the transcript when the payload has no
# prompt_cache block. Real data only — nothing estimated, no countdowns.

input=$(cat)

# --- Deactivation gate: if the statusline plugin is no longer enabled in the
# global settings, remove our own statusLine block (self-uninstall) and render
# nothing. Re-enabling the plugin re-wires it via the SessionStart hook.
_settings="$HOME/.claude/settings.json"
if command -v jq >/dev/null 2>&1 && [ -f "$_settings" ]; then
  _enabled=$(jq -r '(.enabledPlugins // {}) | to_entries
                    | map(select(.key | startswith("statusline@")))
                    | (length > 0) and all(.value)' "$_settings" 2>/dev/null)
  if [ "$_enabled" != "true" ]; then
    _tmp=$(mktemp)
    if jq 'del(.statusLine)' "$_settings" > "$_tmp" 2>/dev/null && jq -e . "$_tmp" >/dev/null 2>&1; then
      mv "$_tmp" "$_settings"
    else
      rm -f "$_tmp"
    fi
    exit 0
  fi
fi

json_get() {
  printf '%s' "$input" | grep -o "\"$1\":\"[^\"]*\"" | head -n1 | cut -d'"' -f4
}

win_to_unix() {
  local p
  p=$(printf '%s' "$1" | sed 's|\\\\|/|g')
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$p" 2>/dev/null || printf '%s' "$p"
  else
    printf '%s' "$p"
  fi
}

mtime() { # file -> epoch seconds; GNU stat then BSD stat
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0
}

cwd=$(win_to_unix "$(json_get current_dir)")
model=$(json_get display_name)
model_id=$(json_get id)
transcript=$(win_to_unix "$(json_get transcript_path)")

# Git info
branch=$(git -C "$cwd" branch --show-current 2>/dev/null)
repo_root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)

# Git status flags: + staged, ! modified, ? untracked, $ stash
git_flags=""
if [ -n "$branch" ]; then
  st=$(git -C "$cwd" status --porcelain 2>/dev/null)
  printf '%s' "$st" | grep -q '^[MADRC]'  && git_flags+='+'
  printf '%s' "$st" | grep -q '^.[MD]'    && git_flags+='!'
  printf '%s' "$st" | grep -q '^??'       && git_flags+='?'
  [ -n "$(git -C "$cwd" stash list -n1 2>/dev/null)" ] && git_flags+='$'
fi

# Directory segment name: repo name when inside a repo, else basename of cwd
if [ -n "$repo_root" ]; then dir_name=${repo_root##*/}
elif [ "$cwd" = "$HOME" ]; then dir_name="~"
else dir_name=${cwd##*/}; fi

# --- 8a palette (truecolor) ---
R='\033[0m'
C_BAR='\033[38;2;46;107;170m'       # #2E6BAA  ▌ accent bar
C_DIR='\033[38;2;159;199;238m'      # #9FC7EE  dir name
C_BRANCH='\033[1;38;2;179;146;224m' # #B392E0 bold  branch
C_FLAGS='\033[38;2;226;166;60m'     # #E2A63C  git flags
C_MODEL='\033[1;38;2;236;233;226m'  # #ECE9E2 bold  model name, brightest text on the line
C_BRIGHTV='\033[38;2;167;173;184m'  # #A7ADB8  neutral values (column-1 tails, cache hit rate)
C_LABEL='\033[38;2;117;123;135m'    # #757B87  labels
C_EMPTY='\033[38;2;58;65;75m'       # #3A414B  empty bar track
C_DIMV='\033[38;2;90;96;107m'       # #5A606B  dim values (cache TTL, Fable countdown)
C_GREEN='\033[38;2;99;190;139m'     # #63BE8B  bar fill, calm
C_AMBER='\033[38;2;226;166;60m'     # #E2A63C  bar fill, past 60%; low cache hit rate
C_AMBERB='\033[1;38;2;226;166;60m'  # bold amber cache TTL, <=5 min or expired
C_REDB='\033[1;38;2;224;86;63m'     # #E0563F bold  bar fill / pct / tail, past 85%
SEP_I=$(printf '%b · %b' '\033[38;2;63;68;77m' "$R")   # #3F444D item separator
# Stands in for a separator before a missing cell, keeping the grid.
SEP_BLANK='   '

fmt_num() { # 600000 -> 600k, 999700 -> 1M, 1500000 -> 1.5M, 9600 -> 9.6k
  # 999500+ would round to "1000k" in the k branch, so it is formatted as M.
  if [ "$1" -ge 999500 ]; then
    awk -v n="$1" 'BEGIN{v=int(n/100000+0.5)/10; printf (v==int(v)) ? "%dM" : "%.1fM", v}'
  elif [ "$1" -ge 10000 ]; then
    awk -v n="$1" 'BEGIN{printf "%dk", int(n/1000+0.5)}'
  elif [ "$1" -ge 1000 ]; then
    awk -v n="$1" 'BEGIN{printf "%.1fk", n/1000}'
  else printf '%s' "$1"; fi
}

# Grid widths in display cells: column 1 (ctx / 5h), column 2 (cache / wk).
COL1_W=35
COL2_W=27

# Pads are computed from ASCII widths only: under Git Bash's C locale ${#s}
# counts bytes, so never measure a string holding ━╸─·▌—.
pad() { # N -> N spaces (none when N <= 0; printf would left-justify a negative)
  [ "$1" -gt 0 ] && printf '%*s' "$1" ""
  return 0
}

# gauge LABEL PCT TRAILING LABEL_W TAIL_W [TRAIL_C]
#   LABEL: gauge label, padded to LABEL_W, then a space
#   PCT: spent percent (bar + percentage right-aligned in 4, in bar colour)
#   TRAILING: countdown/token figure ("" = none), padded to TAIL_W
#   TRAIL_C: trailing value colour; default neutral, bold red past 85%
# Bar: 16 cells in half-cell steps -> halves = round(pct * 32 / 100)
gauge() {
  local label=$1 p=$2 trail=$3 label_w=$4 tail_w=$5 trail_c=$6
  local halves fulls half empties fill_c fills="" empt="" i
  halves=$(( (p * 32 + 50) / 100 ))
  [ "$halves" -gt 32 ] && halves=32
  [ "$halves" -lt 0 ] && halves=0
  fulls=$(( halves / 2 )); half=$(( halves % 2 )); empties=$(( 16 - fulls - half ))
  if   [ "$p" -ge 85 ]; then fill_c=$C_REDB; trail_c=${trail_c:-$C_REDB}
  elif [ "$p" -ge 60 ]; then fill_c=$C_AMBER
  else                       fill_c=$C_GREEN; fi
  trail_c=${trail_c:-$C_BRIGHTV}
  i=0; while [ "$i" -lt "$fulls" ];   do fills+="━"; i=$((i+1)); done
  [ "$half" -eq 1 ] && fills+="╸"
  i=0; while [ "$i" -lt "$empties" ]; do empt+="─"; i=$((i+1)); done
  printf '%b%s%b' "$C_LABEL" "$label" "$R"; pad $(( label_w - ${#label} ))
  printf ' %b%s%b%b%s%b ' "$fill_c" "$fills" "$R" "$C_EMPTY" "$empt" "$R"
  pad $(( 3 - ${#p} )); printf '%b%s%%%b' "$fill_c" "$p" "$R"
  if [ -n "$trail" ] || [ "$tail_w" -gt 0 ]; then
    printf ' %b%s%b' "$trail_c" "$trail" "$R"; pad $(( tail_w - ${#trail} ))
  fi
}

# cache_cell TTL_TEXT TTL_C HIT -> column-2 cell "cache <ttl> <hit>"
#   TTL_TEXT padded to the 16-col area ("" = blank area)
#   HIT: hit-rate percent right-aligned in 4, "-" = expired dash, "" = blank
cache_cell() {
  local ttl=$1 ttl_c=$2 hit=$3 hit_c=$C_BRIGHTV
  printf '%bcache%b %b%s%b' "$C_LABEL" "$R" "$ttl_c" "$ttl" "$R"; pad $(( 17 - ${#ttl} ))
  case "$hit" in
    "") pad 4 ;;
    -)  printf '   %b—%b' "$C_BRIGHTV" "$R" ;;
    *)  [ "$hit" -lt 70 ] && hit_c=$C_AMBER
        pad $(( 3 - ${#hit} )); printf '%b%s%%%b' "$hit_c" "$hit" "$R" ;;
  esac
}

countdown_epoch() { # epoch seconds -> "2h13m" / "4d2h" / "now" / ""
  local target=$1 now diff d h m
  [ -z "$target" ] && return
  now=$(date +%s)
  diff=$(( target - now ))
  [ "$diff" -le 0 ] && { printf 'now'; return; }
  d=$(( diff / 86400 )); h=$(( (diff % 86400) / 3600 )); m=$(( (diff % 3600) / 60 ))
  if [ "$d" -gt 0 ]; then printf '%dd%dh' "$d" "$h"
  elif [ "$h" -gt 0 ]; then printf '%dh%02dm' "$h" "$m"
  else printf '%dm' "$m"; fi
}

countdown() { # ISO timestamp -> "2h13m" / "4d2h" / ""
  [ "$1" = "-" ] && return
  local target ts
  target=$(date -d "$1" +%s 2>/dev/null)
  if [ -z "$target" ]; then
    # BSD date: no -d. Strip fractional seconds and the zone suffix, then parse
    # as UTC — the API emits +00:00, so dropping the offset is lossless here.
    ts=$(printf '%s' "$1" | sed -e 's/\.[0-9]*//' -e 's/Z$//' -e 's/[+-][0-9][0-9]:*[0-9][0-9]$//')
    target=$(date -j -u -f "%Y-%m-%dT%H:%M:%S" "$ts" +%s 2>/dev/null)
  fi
  [ -z "$target" ] && return
  countdown_epoch "$target"
}

# --- Location: where you are — ▌dir branch flags ---
g1=$(printf '%b▌%b%b%s%b' "$C_BAR" "$R" "$C_DIR" "$dir_name" "$R")
if [ -n "$branch" ]; then
  g1+=$(printf ' %b%s%b' "$C_BRANCH" "$branch" "$R")
  [ -n "$git_flags" ] && g1+=$(printf ' %b%s%b' "$C_FLAGS" "$git_flags" "$R")
fi

# --- Live context window from a local OpenAI-compatible server ---
# For private hosts the window the server actually reports is the truth (a
# local --max-context beats any static figure): probe {base}/v1/models then
# {base}/models for data[].max_model_len, cached 60s in
# ~/.claude/.statusline-window.json. Any failure falls through to the
# payload/model-family fallbacks below.
live_window=""
served_model=""
_base="${ANTHROPIC_BASE_URL:-}"
if [ -n "$_base" ] && command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  _host=$(printf '%s' "$_base" | sed -e 's|^[a-zA-Z][a-zA-Z0-9+.-]*://||' -e 's|/.*$||' -e 's|:[0-9]*$||')
  _host=${_host#\[}; _host=${_host%\]}
  _private=0
  case "$_host" in
    localhost|::1|127.*|10.*|192.168.*) _private=1 ;;
    172.*)
      _oct=${_host#172.}; _oct=${_oct%%.*}
      if [ "$_oct" -ge 16 ] 2>/dev/null && [ "$_oct" -le 31 ] 2>/dev/null; then _private=1; fi ;;
  esac
  if [ "$_private" = "1" ]; then
    wcache="$HOME/.claude/.statusline-window.json"
    wage=999999
    [ -f "$wcache" ] && wage=$(( $(date +%s) - $(mtime "$wcache") ))
    if [ "$wage" -gt 60 ]; then
      # Strip a trailing /v1 (and slashes) so the probe never hits /v1/v1/models.
      _b="$_base"
      while :; do
        case "$_b" in
          */v1) _b=${_b%/v1} ;;
          */)   _b=${_b%/} ;;
          *)    break ;;
        esac
      done
      for _url in "$_b/v1/models" "$_b/models"; do
        _body=$(curl -s -m 4 "$_url" 2>/dev/null)
        [ -n "$_body" ] || continue
        _w=$(printf '%s' "$_body" | jq -r '.data[]?.max_model_len // empty' 2>/dev/null | head -n1)
        if [ -n "$_w" ] && [ "$_w" -gt 0 ] 2>/dev/null; then
          live_window=$_w
          # The model the server actually serves (e.g. example-27b) — the
          # tier label Claude Code reports (e.g. "Opus 5.5") is not what runs.
          served_model=$(printf '%s' "$_body" | jq -r '.data[]? | select(.max_model_len != null) | .id // empty' 2>/dev/null | head -n1)
          [ -d "$HOME/.claude" ] && printf '{"window":%s,"model":"%s"}' "$_w" "${served_model//\"/}" > "$wcache"
          break
        fi
      done
    else
      live_window=$(jq -r '.window // empty' "$wcache" 2>/dev/null)
      served_model=$(jq -r '.model // empty' "$wcache" 2>/dev/null)
    fi
  fi
fi

# --- ctx gauge: how full the context window is ---
# Denominator precedence: live server value (private host) > payload
# context_window block (authoritative — matches /context) > model-family map.
used=$(printf '%s' "$input" | grep -o '"total_input_tokens":[0-9]*' | head -n1 | cut -d: -f2)
limit=$(printf '%s' "$input" | grep -o '"context_window_size":[0-9]*' | head -n1 | cut -d: -f2)
pct=$(printf '%s' "$input" | grep -o '"used_percentage":[0-9.]*' | head -n1 | cut -d: -f2 | cut -d. -f1)

# The live value wins for local servers; the payload's percentage was computed
# against the payload's own size, so recompute it against the live limit.
if [ -n "$live_window" ]; then
  limit=$live_window
  pct=""
fi

if [ -z "$used" ]; then
  pct=""
  if [ -n "$transcript" ] && [ -f "$transcript" ]; then
    line=$(tail -c 262144 "$transcript" | grep '"input_tokens"' | tail -n1)
    if [ -n "$line" ]; then
      # Missing fields (local proxies omit cache fields) must yield 0, not an
      # empty operand — an empty one is an arithmetic syntax error on stderr.
      num() { local v; v=$(printf '%s' "$line" | grep -o "\"$1\":[0-9]*" | head -n1 | cut -d: -f2); [ -n "$v" ] || v=0; printf '%s' "$v"; }
      used=$(( $(num input_tokens) + $(num cache_read_input_tokens) + $(num cache_creation_input_tokens) ))
    fi
  fi
fi

if [ -z "$limit" ] || [ "${limit:-0}" -eq 0 ]; then
  mid=$(printf '%s' "$model_id" | tr 'A-Z' 'a-z')
  case "$mid" in
    *haiku*)  limit=${CLAUDE_CONTEXT_WINDOW:-200000} ;;
    *"[1m]"*|*fable*|*mythos*|*opus-5*|*opus-4-8*|*opus-4-7*|*opus-4-6*|*sonnet-5*|*sonnet-4-6*)
              limit=${CLAUDE_CONTEXT_WINDOW:-1000000} ;;
    *)        limit=${CLAUDE_CONTEXT_WINDOW:-200000}
              case "$input" in *"[1m]"*) limit=${CLAUDE_CONTEXT_WINDOW:-1000000} ;; esac ;;
  esac
fi

ctx_trail=""
if [ -n "$used" ] && [ "$used" -gt 0 ] 2>/dev/null; then
  [ -z "$pct" ] && pct=$(( used * 100 / limit ))
  used_s=$(fmt_num "$used")
  ctx_trail="$used_s/$(fmt_num "$limit")"
  # The tail cell is 7 cols; when the pair won't fit, the pct carries the ratio.
  [ "${#ctx_trail}" -gt 7 ] && ctx_trail=$used_s
fi

# On a local server show the model it actually serves; fall back to the tier
# label Claude Code reports when the probe found nothing.
display_model="${served_model:-$model}"

# Prompt-cache health: main-conversation cache summary, added to the payload
# after the first API response (v2.1.251+). When the block is absent (older
# Claude Code, or local models) the group is derived from the transcript's
# assistant usages instead. Real data only: omit silently until the last
# usage has a positive denominator.
cache_seg=""
if command -v jq >/dev/null 2>&1; then
  # jq on Windows writes CRLF to stdout; strip the \r so the last @tsv field
  # (read by bash without word-splitting it away) doesn't carry a stray byte.
  read -r pc_present pc_warm pc_observed pc_expires pc_misses pc_hit < <(printf '%s' "$input" | jq -r '
    (.prompt_cache // {}) as $c |
    [ has("prompt_cache"), ($c.warm // false), ($c.caching_observed // false),
      (($c.expires_at // -1) | if type == "number" then floor else -1 end), ($c.misses // 0),
      ($c.hit_ratio // -1) ] | @tsv' 2>/dev/null | tr -d '\r')

  if [ "$pc_present" = "true" ]; then
    if [ "$pc_observed" = "true" ]; then
      hh=""
      [ "${pc_hit:--1}" != "-1" ] && hh=$(awk -v h="$pc_hit" 'BEGIN{printf "%d", h*100+0.5}')
      ttl_s=""
      [ "${pc_expires:--1}" != "-1" ] && ttl_s=$(( pc_expires - $(date +%s) ))
      # 8a renders neither pc_misses nor a warm/cold glyph: no room in the cell.
      if [ "$pc_warm" != "true" ] || { [ -n "$ttl_s" ] && [ "$ttl_s" -le 0 ]; }; then
        cache_seg=$(cache_cell "expired" "$C_AMBERB" "-")
      elif [ -z "$ttl_s" ]; then
        cache_seg=$(cache_cell "" "" "$hh")
      else
        ttl_c=$C_DIMV; [ "$ttl_s" -le 300 ] && ttl_c=$C_AMBERB
        cache_seg=$(cache_cell "expires in $(countdown_epoch "$pc_expires")" "$ttl_c" "$hh")
      fi
    fi
  else
    # Transcript-derived group: the last assistant usage's hit rate
    # cache_read/(input+cache_read+cache_creation) plus a session miss
    # counter (usages carrying cache fields with cache_read == 0).
    if [ -n "$transcript" ] && [ -f "$transcript" ]; then
      read -r tc_hit tc_miss < <(jq -rn '
        [ inputs
          | select(type == "object")
          | select((.type // "") == "assistant")
          | select((.message // null) | type == "object")
          | .message.usage
          | select(type == "object")
          | { ti: (.input_tokens // 0), cr: (.cache_read_input_tokens // 0),
              cw: (.cache_creation_input_tokens // 0),
              hasc: ((.cache_read_input_tokens != null) or (.cache_creation_input_tokens != null)) } ]
        | map(select((.ti + .cr + .cw) > 0)) as $us
        | ($us | map(select(.hasc and .cr == 0)) | length) as $miss
        | ($us | last) as $last
        | if $last == null then empty
          else [ ((($last.cr * 100 / ($last.ti + $last.cr + $last.cw)) + 0.5) | floor), $miss ] | @tsv
          end' "$transcript" 2>/dev/null | tr -d '\r')
      # No TTL from a local server: blank area. tc_miss is not rendered in 8a.
      [ -n "$tc_hit" ] && cache_seg=$(cache_cell "" "" "$tc_hit")
    fi
  fi
fi

# --- Line 3: what you have left — 5h · wk · Fable ---
cache="$HOME/.claude/.statusline-usage.json"
creds="$HOME/.claude/.credentials.json"

cache_age=999999
if [ -f "$cache" ]; then
  cache_age=$(( $(date +%s) - $(mtime "$cache") ))
fi

if [ "$cache_age" -gt 60 ]; then
  # Token source is platform-dependent: Git Bash/Linux keep a credentials file,
  # macOS stores the identical JSON in the login Keychain. File wins when present.
  tok=""
  if [ -f "$creds" ]; then
    tok=$(grep -o '"accessToken":"[^"]*"' "$creds" | cut -d'"' -f4)
  elif command -v security >/dev/null 2>&1; then
    tok=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null \
          | grep -o '"accessToken":"[^"]*"' | head -n1 | cut -d'"' -f4)
  fi
  if [ -n "$tok" ]; then
    fresh=$(curl -s -m 4 "https://api.anthropic.com/api/oauth/usage" \
      -H "Authorization: Bearer $tok" \
      -H "anthropic-beta: oauth-2025-04-20" \
      -H "Content-Type: application/json" 2>/dev/null)
    if printf '%s' "$fresh" | grep -q '"limits"'; then
      printf '%s' "$fresh" > "$cache"
    fi
  fi
fi

if [ -f "$cache" ] && command -v jq >/dev/null 2>&1; then
  read -r s_pct s_reset w_pct f_pct f_reset < <(jq -r '
    def lim(k): (.limits[]? | select(.kind == k)) // {};
    [ (lim("session").percent // -1),
      (lim("session").resets_at // "-"),
      (lim("weekly_all").percent // -1),
      (lim("weekly_scoped").percent // -1),
      (lim("weekly_scoped").resets_at // "-") ] | @tsv' "$cache" 2>/dev/null | tr '\t' ' ' | tr -d '\r')

  s_trail=$(countdown "${s_reset:--}")
  f_trail=$(countdown "${f_reset:--}")
fi

# --- Assemble on the grid ---
# A missing cell with something after it on its line becomes spaces (and so
# does the separator before it); trailing missing cells are dropped.
# Line 2: ctx · cache
line2=""
if [ -n "$ctx_trail" ]; then
  c_tw=0; [ -n "$cache_seg" ] && c_tw=7
  line2=$(gauge "ctx" "$pct" "$ctx_trail" 5 "$c_tw")
elif [ -n "$cache_seg" ]; then
  line2="$(pad "$COL1_W")${SEP_BLANK}"
fi
[ -n "$cache_seg" ] && { [ -n "$ctx_trail" ] && line2+="$SEP_I"; line2+="$cache_seg"; }

# Line 3: 5h · wk · Fable
has_s=0; [ "${s_pct:--1}" != "-1" ] && has_s=1
has_w=0; [ "${w_pct:--1}" != "-1" ] && has_w=1
has_f=0; [ "${f_pct:--1}" != "-1" ] && has_f=1
line3=""
if [ $(( has_s + has_w + has_f )) -gt 0 ]; then
  if [ "$has_s" = 1 ]; then
    s_tw=0; [ $(( has_w + has_f )) -gt 0 ] && s_tw=7
    line3=$(gauge "5h" "$s_pct" "$s_trail" 5 "$s_tw")
  else
    line3=$(pad "$COL1_W")
  fi
  if [ "$has_w" = 1 ]; then
    line3+="${SEP_I}$(gauge "wk" "$w_pct" "" 5 0)"
  elif [ "$has_f" = 1 ]; then
    line3+="${SEP_BLANK}$(pad "$COL2_W")"
  fi
  [ "$has_f" = 1 ] && line3+="${SEP_I}$(gauge "Fable" "$f_pct" "$f_trail" 5 0 "$C_DIMV")"
fi

# Line 1: ▌dir branch flags · model — identity, unpadded
out=$g1
[ -n "$display_model" ] && out+="${SEP_I}$(printf '%b%s%b' "$C_MODEL" "$display_model" "$R")"
# Claude Code renders each stdout line as its own statusline row.
[ -n "$line2" ] && out+=$'\n'"${line2}"
[ -n "$line3" ] && out+=$'\n'"${line3}"
printf '%s' "$out"
