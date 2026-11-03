#!/bin/bash
# PostToolUse hook: rewrite working-tree files to CRLF wherever git attributes
# say eol=crlf but the file holds LF or mixed endings. Claude Code's Write tool
# and shell edits (sed -i, heredocs, redirection) emit LF, which leaves files
# "modified" with an empty diff. Exits at once when no attribute source (a
# tracked .gitattributes, the repo's info/attributes, the global attributes
# file) mentions eol=crlf. Otherwise scans only the file the hook input names
# (tool_input.file_path or notebook_path, read with jq); with no such path —
# Bash, PowerShell, no jq — it scans the modified and untracked files.
# Prints nothing and always exits 0 — no hook noise, never blocks a tool.
#
# Invoked bare (no CLAUDE_PROJECT_DIR), this rewrites the repo containing $PWD
# — export CLAUDE_PROJECT_DIR when testing.
#
# Only files git reports as text (w/lf or w/mixed) are touched; binaries,
# symlinks and files already CRLF are left alone. A missing final newline is
# preserved. Each rewrite goes through a temp file in the same directory, so a
# failure never truncates the original.

set -u

# Read the whole input up front so the writer never sees a broken pipe.
input=
[ -t 0 ] || input=$(cat 2>/dev/null)

top=$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$top" 2>/dev/null || exit 0

crlf_wanted() {
  local info global
  info=$(git rev-parse --git-path info/attributes 2>/dev/null) || return 0
  # Unset core.attributesFile: git reads $XDG_CONFIG_HOME/git/attributes, else ~/.config/git/attributes.
  global=$(git config --type=path --get core.attributesFile 2>/dev/null) || global=${XDG_CONFIG_HOME:-${HOME:-}/.config}/git/attributes
  grep -qsF 'eol=crlf' -- "$info" "$global" && return 0
  git grep -q -F -e 'eol=crlf' -- ':(glob)**/.gitattributes' 2>/dev/null
  # 1 is "no match"; any other failure scans rather than skip a CRLF repo.
  [ $? -ne 1 ]
}
crlf_wanted || exit 0

target=
if [ -n "$input" ] && command -v jq >/dev/null 2>&1; then
  # -j, not -r: a native Windows jq would end the line in CRLF.
  target=$(printf '%s' "$input" | jq -j '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null) || target=
fi
if [ -n "$target" ]; then
  scope=(-c -o --exclude-standard -- "$target")
else
  scope=(-m -o --exclude-standard)
fi

# Pure bash, not sed: Git for Windows sed strips CR on read.
to_crlf() {
  local line
  while IFS= read -r line; do
    printf '%s\r\n' "${line%$'\r'}"
  done
  [ -z "$line" ] || printf '%s' "$line"
}

converted=()
# Record: "i/<eol> w/<eol> attr/<attrs> <TAB><path>", fields space-padded.
while IFS= read -r -d '' rec; do
  info=${rec%%$'\t'*}
  path=${rec#*$'\t'}
  w=${info#*w/}
  w=${w%% *}
  case "$w" in lf|mixed) ;; *) continue ;; esac
  attr=${info#*attr/}
  attr=${attr%"${attr##*[! ]}"}
  case "$attr" in "text eol=crlf"|"text=auto eol=crlf") ;; *) continue ;; esac
  [ -f "$path" ] && [ ! -L "$path" ] || continue
  dir=$(dirname "$path")
  tmp=$(mktemp "$dir/.restore-crlf.XXXXXX" 2>/dev/null) || continue
  # cp -p first so the rewrite keeps the original's mode.
  if cp -p "$path" "$tmp" 2>/dev/null && to_crlf < "$path" > "$tmp" 2>/dev/null; then
    mv -f "$tmp" "$path" 2>/dev/null && converted+=("$path") || rm -f "$tmp"
  else
    rm -f "$tmp"
  fi
done < <(git --literal-pathspecs ls-files --eol -z "${scope[@]}" 2>/dev/null)

# A converted tracked file whose index stat was recorded from an LF worktree
# would show "modified" with an empty diff. Re-record its stat, but only when
# its cleaned content equals the index blob, so real edits are never staged.
refresh=()
for path in ${converted[@]+"${converted[@]}"}; do
  staged=$(git rev-parse -q --verify ":0:$path" 2>/dev/null) || continue
  [ "$(git hash-object --path="$path" -- "$path" 2>/dev/null)" = "$staged" ] && refresh+=("$path")
done
# Fails harmlessly (e.g. index.lock held); the file then just stays "modified".
[ ${#refresh[@]} -eq 0 ] || printf '%s\0' "${refresh[@]}" | git update-index -z --stdin >/dev/null 2>&1
exit 0
