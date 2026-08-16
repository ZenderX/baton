#!/bin/bash
# Claude Code statusline — design "2a: Gauges, tightened":
#   ▌dir branch !?$ │ Fable 5 ██▌░░░ 40% 397k/1M │ 5h ████░░ 70% 3h03m · wk █░░░░░ 20% · Fable ██░░░░ 31% 4d2h
# Two separator weights: │ divides the three groups (where you are / what you're
# talking to and how full it is / what you have left); · separates budget items.
# Bars are six cells read in half-cells (▌) = 8.3% resolution. Every bar is
# followed by its percentage in the bar's own colour; the dim trailing value is
# the thing that counts down (tokens against the window, time left in period).
# Colour derived: green under 60%, amber past 60%, red past 85% (pct bold red;
# time-critical countdowns bold red too).
# Reactive: settings.json statusLine.refreshInterval=60 re-runs this every
# minute even when idle. Reads Claude Code's JSON payload on stdin. Plan usage
# from the OAuth usage endpoint (same source as /usage), cached 60s in ~/.claude/.

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

# --- 2a palette (truecolor) ---
R='\033[0m'
C_BAR='\033[38;2;46;107;170m'       # #2E6BAA  ▌ accent bar
C_DIR='\033[38;2;159;199;238m'      # #9FC7EE  dir name
C_BRANCH='\033[1;38;2;179;146;224m' # #B392E0 bold  branch
C_FLAGS='\033[38;2;226;166;60m'     # #E2A63C  git flags
C_MODEL='\033[38;2;167;173;184m'    # #A7ADB8  model name / brightened values
C_LABEL='\033[38;2;117;123;135m'    # #757B87  budget labels
C_EMPTY='\033[38;2;52;58;67m'       # #343A43  empty gauge cells
C_DIMV='\033[38;2;90;96;107m'       # #5A606B  dim trailing values
C_GREEN='\033[38;2;99;190;139m'     # #63BE8B  gauge fill, calm
C_AMBER='\033[38;2;226;166;60m'     # #E2A63C  gauge fill, past 60%
C_RED='\033[38;2;224;86;63m'        # #E0563F  gauge fill, past 85%
C_REDB='\033[1;38;2;224;86;63m'     # bold red pct
C_TIME='\033[38;2;123;163;204m'     # #7BA3CC  reset countdowns — severity-independent
                                    # (low time-left is GOOD; never inherits bar red)
SEP_G=$(printf '%b │ %b' '\033[38;2;74;80;88m' "$R")   # #4A5058 group separator
SEP_I=$(printf '%b · %b' '\033[38;2;63;68;77m' "$R")   # #3F444D item separator

fmt_num() { # 600000 -> 600k, 1000000 -> 1M, 1500000 -> 1.5M, 9600 -> 9.6k
  if [ "$1" -ge 1000000 ]; then
    awk -v n="$1" 'BEGIN{v=n/1000000; printf (v==int(v)) ? "%dM" : "%.1fM", v}'
  elif [ "$1" -ge 10000 ]; then
    awk -v n="$1" 'BEGIN{printf "%dk", int(n/1000+0.5)}'
  elif [ "$1" -ge 1000 ]; then
    awk -v n="$1" 'BEGIN{printf "%.1fk", n/1000}'
  else printf '%s' "$1"; fi
}

# gauge LABEL PCT TRAILING KIND
#   LABEL: budget label ("" = none, label rendered by caller e.g. model name)
#   PCT: spent percent (bar + percentage in bar colour, bold at red)
#   TRAILING: dim countdown/token figure ("" = none)
#   KIND: "time" (bold red at red severity) | "tokens" (brightens, never red)
# Bar: 6 cells in half-cell steps -> halves = round(pct * 12 / 100)
gauge() {
  local label=$1 p=$2 trail=$3 kind=$4
  local halves fulls half empties fill_c pct_c trail_c fills="" empt="" i
  halves=$(( (p * 12 + 50) / 100 ))
  [ "$halves" -gt 12 ] && halves=12
  [ "$halves" -lt 0 ] && halves=0
  fulls=$(( halves / 2 )); half=$(( halves % 2 )); empties=$(( 6 - fulls - half ))
  if   [ "$p" -ge 85 ]; then fill_c=$C_RED;   pct_c=$C_REDB
  elif [ "$p" -ge 60 ]; then fill_c=$C_AMBER; pct_c=$C_AMBER
  else                       fill_c=$C_GREEN; pct_c=$C_GREEN; fi
  # trailing value colour: countdowns are always the complementary blue
  # (low time-left is good — decoupled from bar severity); token figures
  # stay dim and brighten with severity
  if   [ "$kind" = "time" ]; then trail_c=$C_TIME
  elif [ "$p" -ge 60 ]; then trail_c=$C_MODEL
  else                       trail_c=$C_DIMV; fi
  i=0; while [ "$i" -lt "$fulls" ];   do fills+="█"; i=$((i+1)); done
  [ "$half" -eq 1 ] && fills+="▌"
  i=0; while [ "$i" -lt "$empties" ]; do empt+="░"; i=$((i+1)); done
  [ -n "$label" ] && printf '%b%s%b ' "$C_LABEL" "$label" "$R"
  printf '%b%s%b%b%s%b%b%s%%%b' "$fill_c" "$fills" "$R" "$C_EMPTY" "$empt" "$R" "$pct_c" "$p" "$R"
  [ -n "$trail" ] && printf ' %b%s%b' "$trail_c" "$trail" "$R"
}

# --- Group 1: where you are — ▌dir branch flags ---
g1=$(printf '%b▌%b%b%s%b' "$C_BAR" "$R" "$C_DIR" "$dir_name" "$R")
if [ -n "$branch" ]; then
  g1+=$(printf ' %bon%b %b %s%b' "$C_LABEL" "$R" "$C_BRANCH" "$branch" "$R")
  [ -n "$git_flags" ] && g1+=$(printf ' %b%s%b' "$C_FLAGS" "$git_flags" "$R")
fi

# --- Group 2: what you're talking to and how full it is — Model + ctx gauge ---
# Prefer the payload's own context_window block (authoritative — matches /context);
# fall back to the transcript's last usage block + model-family window.
g2=""
used=$(printf '%s' "$input" | grep -o '"total_input_tokens":[0-9]*' | head -n1 | cut -d: -f2)
limit=$(printf '%s' "$input" | grep -o '"context_window_size":[0-9]*' | head -n1 | cut -d: -f2)
pct=$(printf '%s' "$input" | grep -o '"used_percentage":[0-9.]*' | head -n1 | cut -d: -f2 | cut -d. -f1)

if [ -z "$used" ] || [ -z "$limit" ] || [ "${limit:-0}" -eq 0 ]; then
  used=""; pct=""
  if [ -n "$transcript" ] && [ -f "$transcript" ]; then
    line=$(tail -c 262144 "$transcript" | grep '"input_tokens"' | tail -n1)
    if [ -n "$line" ]; then
      num() { printf '%s' "$line" | grep -o "\"$1\":[0-9]*" | head -n1 | cut -d: -f2; }
      used=$(( $(num input_tokens || echo 0) + $(num cache_read_input_tokens || echo 0) + $(num cache_creation_input_tokens || echo 0) ))
      mid=$(printf '%s' "$model_id" | tr 'A-Z' 'a-z')
      case "$mid" in
        *haiku*)  limit=${CLAUDE_CONTEXT_WINDOW:-200000} ;;
        *"[1m]"*|*fable*|*mythos*|*opus-5*|*opus-4-8*|*opus-4-7*|*opus-4-6*|*sonnet-5*|*sonnet-4-6*)
                  limit=${CLAUDE_CONTEXT_WINDOW:-1000000} ;;
        *)        limit=${CLAUDE_CONTEXT_WINDOW:-200000}
                  case "$input" in *"[1m]"*) limit=${CLAUDE_CONTEXT_WINDOW:-1000000} ;; esac ;;
      esac
    fi
  fi
fi

if [ -n "$model" ]; then
  g2=$(printf '%b[%s]%b' "$C_MODEL" "$model" "$R")
  if [ -n "$used" ] && [ "$used" -gt 0 ] 2>/dev/null; then
    [ -z "$pct" ] && pct=$(( used * 100 / limit ))
    g2+=" $(gauge "" "$pct" "$(fmt_num "$used")/$(fmt_num "$limit")" tokens)"
  fi
fi

# --- Group 3: what you have left — 5h · wk · Fable ---
seg_5h=""; seg_wk=""; seg_fable=""
cache="$HOME/.claude/.statusline-usage.json"
creds="$HOME/.claude/.credentials.json"

cache_age=999999
if [ -f "$cache" ]; then
  cache_age=$(( $(date +%s) - $(date -r "$cache" +%s 2>/dev/null || echo 0) ))
fi

if [ "$cache_age" -gt 60 ] && [ -f "$creds" ]; then
  tok=$(grep -o '"accessToken":"[^"]*"' "$creds" | cut -d'"' -f4)
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
      (lim("weekly_scoped").resets_at // "-") ] | @tsv' "$cache" 2>/dev/null | tr '\t' ' ')

  countdown() { # ISO timestamp -> "2h13m" / "4d2h" / ""
    [ "$1" = "-" ] && return
    local target now diff d h m
    target=$(date -d "$1" +%s 2>/dev/null) || return
    now=$(date +%s)
    diff=$(( target - now ))
    [ "$diff" -le 0 ] && { printf 'now'; return; }
    d=$(( diff / 86400 )); h=$(( (diff % 86400) / 3600 )); m=$(( (diff % 3600) / 60 ))
    if [ "$d" -gt 0 ]; then printf '%dd%dh' "$d" "$h"
    elif [ "$h" -gt 0 ]; then printf '%dh%02dm' "$h" "$m"
    else printf '%dm' "$m"; fi
  }

  # countdowns in parentheses, single space after the percentage
  if [ "${s_pct:--1}" != "-1" ]; then
    v=$(countdown "${s_reset:--}")
    [ -n "$v" ] && v="($v)"
    seg_5h=$(gauge "5h" "$s_pct" "$v" time)
  fi
  if [ "${w_pct:--1}" != "-1" ]; then
    seg_wk=$(gauge "wk" "$w_pct" "" time)
  fi
  if [ "${f_pct:--1}" != "-1" ]; then
    v=$(countdown "${f_reset:--}")
    [ -n "$v" ] && v="($v)"
    seg_fable=$(gauge "Fable" "$f_pct" "$v" time)
  fi
fi

# --- Assemble: g1 │ g2 │ 5h · wk · Fable (skip empty groups/items) ---
out="$g1"
[ -n "$g2" ] && out+="${SEP_G}${g2}"
g3=""
for s in "$seg_5h" "$seg_wk" "$seg_fable"; do
  [ -z "$s" ] && continue
  [ -n "$g3" ] && g3+="$SEP_I"
  g3+="$s"
done
[ -n "$g3" ] && out+="${SEP_G}${g3}"
printf '%s' "$out"
