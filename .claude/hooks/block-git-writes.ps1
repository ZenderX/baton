#!/usr/bin/env pwsh
# block-git-writes.ps1 — PreToolUse hook (cross-platform PowerShell) that blocks
# mutating git commands while allowing all read-only git operations.
#
# Defense-in-depth layer behind permissions.deny. Reads the Claude hook JSON from
# stdin, tokenizes the Bash command string respecting shell quoting, and exits 2
# (block) only when a mutating git operation is positively identified.
#
# Tokenization: a char-by-char parser tracks quote state (single/double) so a git
# verb inside a quoted literal (echo "git push", grep "git add" f) becomes part of
# a single token and is NOT treated as a command. Shell operators (&& || ; | &) and
# newlines flush the current token and emit a boundary marker; only a 'git' token
# that sits at a statement start position is inspected.
#
# RESIDUAL GAP (by design, do not fix):
# - git-writes hidden inside inner quoted strings (bash -c "git push", $(git push))
#   are NOT caught; the tokenizer collapses them to a single token.
# Both gaps are deliberate. The permissions.deny list and the git-hygiene engineering
# rule remain the backstop for adversarial cases.
#
# FAIL-OPEN: parse error, non-Bash tool, missing command, or any unexpected error
# → exit 0 (allow). Only exit 2 when a mutating git operation is POSITIVELY identified.
#
# Exit codes:
#   0 — allow (not a mutating git command, or could not determine)
#   2 — block (mutating git command detected)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Statement boundary tokens — the token immediately following one starts a new statement
$BOUNDARIES = @('&&', '||', ';', '|', '&')

# Git global flags that consume the NEXT token as their argument (skip both)
$GIT_FLAGS_CONSUMING_NEXT = @('-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--exec-path')

# Always-block git subcommands — no useful read-only form
$ALWAYS_BLOCK = @(
    'add', 'commit', 'push', 'pull', 'fetch', 'reset', 'restore',
    'checkout', 'switch', 'rebase', 'merge', 'cherry-pick', 'revert',
    'clean', 'rm', 'mv', 'am', 'apply', 'commit-tree', 'update-ref',
    'filter-branch', 'gc', 'prune', 'repack'
)

# Branch flags that indicate a mutating operation (deletion/rename/upstream)
$BRANCH_MUTATING_FLAGS = @(
    '-d', '-D', '-m', '-M', '-c', '-C', '--edit-description',
    '--delete', '--move', '--copy', '--force', '-f',
    '--set-upstream-to', '-u', '--unset-upstream', '--track', '--no-track'
)

# Tag flags that indicate a mutating operation
$TAG_MUTATING_FLAGS = @('-d', '-a', '-s', '-m', '-f', '--delete', '--annotate', '--sign', '--message', '--force')

# Tag flags that signal a listing/read-only operation (neutralize a positional pattern arg)
$TAG_ALLOW_FLAGS = @('-l', '--list', '-n', '--contains', '--points-at', '--sort', '--format', '--merged', '--no-merged', '--column', '--no-column')

# Stash sub-subcommands that are write operations
$STASH_BLOCK = @('push', 'save', 'pop', 'apply', 'drop', 'clear', 'create', 'store')

# Worktree sub-subcommands that are write operations
$WORKTREE_BLOCK = @('add', 'remove', 'move', 'prune', 'repair', 'lock', 'unlock')

# Remote sub-subcommands that are write operations
$REMOTE_BLOCK = @('add', 'remove', 'rm', 'rename', 'set-url', 'set-head', 'set-branches', 'prune', 'update')

# Notes sub-subcommands that are write operations
$NOTES_BLOCK = @('add', 'copy', 'append', 'edit', 'remove', 'prune')

# ---------------------------------------------------------------------------
# Tokenizer — respects shell quoting so "git push" is one token
# ---------------------------------------------------------------------------

function ConvertTo-ShellTokens {
    <#
    .SYNOPSIS
        Tokenizes a shell command string, respecting single- and double-quoted strings.
        Operators (&&, ||, ;, |, &) and newlines are emitted as separate boundary tokens.
        A quoted substring collapses to a single token: echo "git push" → ["echo", "git push"].
    .PARAMETER Command
        Raw Bash command string from the Claude hook payload.
    .OUTPUTS
        [string[]] Token list. Operators appear as standalone tokens.
    #>
    param([string]$Command)

    $tokens = [System.Collections.Generic.List[string]]::new()
    $buf = [System.Text.StringBuilder]::new()
    $inSingle = $false
    $inDouble = $false
    $i = 0
    $len = $Command.Length

    while ($i -lt $len) {
        $c = $Command[$i]

        # Inside single-quoted string: literal until closing '
        if ($inSingle) {
            if ($c -eq "'") { $inSingle = $false }
            else { [void]$buf.Append($c) }
            $i++
            continue
        }

        # Inside double-quoted string: literal until closing "
        # Escape sequences intentionally ignored — fail-open on edge cases
        if ($inDouble) {
            if ($c -eq '"') { $inDouble = $false }
            else { [void]$buf.Append($c) }
            $i++
            continue
        }

        # Unquoted: quote start
        if ($c -eq "'") { $inSingle = $true; $i++; continue }
        if ($c -eq '"') { $inDouble = $true; $i++; continue }

        # Two-character operators before single-character ones (order matters)
        $two = if ($i + 1 -lt $len) { "$c$($Command[$i+1])" } else { '' }
        if ($two -eq '&&' -or $two -eq '||') {
            if ($buf.Length -gt 0) { $tokens.Add($buf.ToString()); [void]$buf.Clear() }
            $tokens.Add($two)
            $i += 2
            continue
        }

        # Single-character shell operators
        if ($c -eq ';' -or $c -eq '|' -or $c -eq '&') {
            if ($buf.Length -gt 0) { $tokens.Add($buf.ToString()); [void]$buf.Clear() }
            $tokens.Add([string]$c)
            $i++
            continue
        }

        # Newline as statement separator (normalize to semicolon boundary token)
        if ($c -eq "`n" -or $c -eq "`r") {
            if ($buf.Length -gt 0) { $tokens.Add($buf.ToString()); [void]$buf.Clear() }
            $tokens.Add(';')
            $i++
            continue
        }

        # Whitespace flushes current token
        if ($c -eq ' ' -or $c -eq "`t") {
            if ($buf.Length -gt 0) { $tokens.Add($buf.ToString()); [void]$buf.Clear() }
            $i++
            continue
        }

        # Regular character — accumulate into current token
        [void]$buf.Append($c)
        $i++
    }

    if ($buf.Length -gt 0) { $tokens.Add($buf.ToString()) }

    # Comma prefix forces PowerShell to return the array as-is (not unroll single elements)
    return , $tokens.ToArray()
}

# ---------------------------------------------------------------------------
# Git subcommand extraction — skips global git flags
# ---------------------------------------------------------------------------

function Get-GitSubcommand {
    <#
    .SYNOPSIS
        Walks tokens starting at $Start, skipping git global flags, to find the
        git subcommand. Stops at any statement boundary.
    .PARAMETER Tokens
        Full token array from ConvertTo-ShellTokens.
    .PARAMETER Start
        Index of the first token after 'git'.
    .OUTPUTS
        Hashtable with Subcommand (string or $null) and NextIndex (int).
    #>
    param([string[]]$Tokens, [int]$Start)

    $i = $Start
    while ($i -lt $Tokens.Count) {
        $t = $Tokens[$i]

        if ($BOUNDARIES -contains $t) {
            return @{ Subcommand = $null; NextIndex = $i }
        }

        if (-not $t.StartsWith('-')) {
            # First non-flag token is the subcommand
            return @{ Subcommand = $t; NextIndex = $i + 1 }
        }

        # Flag: extract base name to handle --flag=value embedded form
        $flagBase = if ($t -match '^([^=]+)=') { $Matches[1] } else { $t }
        if ($GIT_FLAGS_CONSUMING_NEXT -contains $flagBase) {
            # Value is either embedded (--flag=val, skip 1) or next token (skip 2)
            $i += if ($t -match '=') { 1 } else { 2 }
        } else {
            $i += 1  # standalone flag
        }
    }

    return @{ Subcommand = $null; NextIndex = $i }
}

# ---------------------------------------------------------------------------
# Dual-mode subcommand inspectors
# ---------------------------------------------------------------------------

function Test-BranchMutating {
    <#
    .SYNOPSIS
        Returns $true if 'git branch' args indicate a mutating operation.
        Bare 'git branch', -a, -r, -v, -vv, --show-current are read-only.
        -l/--list with a positional = listing pattern (read-only, like 'git tag -l').
        Any positional without a list flag = branch name to create (mutating).
        Any $BRANCH_MUTATING_FLAGS flag = mutating regardless.
    #>
    param([string[]]$Tokens, [int]$Start)

    $hasListFlag = $false
    $hasPositional = $false

    for ($i = $Start; $i -lt $Tokens.Count; $i++) {
        $t = $Tokens[$i]
        if ($BOUNDARIES -contains $t) { break }
        if ($BRANCH_MUTATING_FLAGS -contains $t) { return $true }  # immediately mutating
        if ($t -eq '-l' -or $t -eq '--list') { $hasListFlag = $true; continue }
        if (-not $t.StartsWith('-')) { $hasPositional = $true }
    }

    # Positional + no list flag = branch creation. Positional + list flag = pattern, read-only.
    return $hasPositional -and (-not $hasListFlag)
}

function Test-TagMutating {
    <#
    .SYNOPSIS
        Returns $true if 'git tag' args indicate a mutating operation.
        Bare 'git tag' and -l/--list/--contains/--points-at are read-only.
        A positional (tag name) without an explicit list flag = tag creation (mutating).
        -d/-a/-s/-m/-f flags = delete/annotate/sign/message/force = mutating.
    #>
    param([string[]]$Tokens, [int]$Start)

    $hasPositional = $false
    $hasListFlag = $false

    for ($i = $Start; $i -lt $Tokens.Count; $i++) {
        $t = $Tokens[$i]
        if ($BOUNDARIES -contains $t) { break }
        if ($TAG_MUTATING_FLAGS -contains $t) { return $true }
        if ($TAG_ALLOW_FLAGS -contains $t) { $hasListFlag = $true; continue }
        if (-not $t.StartsWith('-')) { $hasPositional = $true }
    }

    # Positional without a list flag = creating a tag
    return $hasPositional -and (-not $hasListFlag)
}

function Get-FirstPositional {
    <#
    .SYNOPSIS
        Returns the first non-flag, non-boundary token at or after $Start, or $null.
        Used to find sub-subcommands for stash, worktree, remote, notes.
    .PARAMETER Tokens
        Full token array.
    .PARAMETER Start
        Index to start scanning from.
    #>
    param([string[]]$Tokens, [int]$Start)

    for ($i = $Start; $i -lt $Tokens.Count; $i++) {
        $t = $Tokens[$i]
        if ($BOUNDARIES -contains $t) { return $null }
        if (-not $t.StartsWith('-')) { return $t }
    }
    return $null
}

# ---------------------------------------------------------------------------
# Main detection
# ---------------------------------------------------------------------------

function Find-GitWrite {
    <#
    .SYNOPSIS
        Tokenizes the Bash command string and walks statement-by-statement, inspecting
        only 'git' tokens that appear at statement-start positions. Returns a block-reason
        string when a mutating git operation is found, $null otherwise.
        Always returns $null on any tokenization error (fail-open).
    .PARAMETER Command
        Raw Bash command string from the Claude hook payload.
    #>
    param([string]$Command)

    $tokens = ConvertTo-ShellTokens $Command
    if ($null -eq $tokens -or $tokens.Count -eq 0) { return $null }

    $atStart = $true  # the beginning of a command string is a statement start
    $i = 0

    while ($i -lt $tokens.Count) {
        $t = $tokens[$i]

        if ($BOUNDARIES -contains $t) {
            $atStart = $true
            $i++
            continue
        }

        if ($atStart -and $t -eq 'git') {
            $result = Get-GitSubcommand $tokens ($i + 1)
            $sub    = $result.Subcommand
            $next   = $result.NextIndex

            if ($null -eq $sub) {
                # Bare 'git' with no subcommand — allow
                $atStart = $false
                $i = $next
                continue
            }

            # Always-block subcommands (no read-only form)
            if ($ALWAYS_BLOCK -contains $sub) {
                return "Blocked: 'git $sub' is a write operation"
            }

            # Dual-mode: branch — inspect args to distinguish listing from creating
            if ($sub -eq 'branch') {
                if (Test-BranchMutating $tokens $next) {
                    return "Blocked: 'git branch' with mutating args (creation/deletion/rename)"
                }
                $atStart = $false
                $i = $next
                continue
            }

            # Dual-mode: tag — inspect args to distinguish listing from creating/deleting
            if ($sub -eq 'tag') {
                if (Test-TagMutating $tokens $next) {
                    return "Blocked: 'git tag' with mutating args"
                }
                $atStart = $false
                $i = $next
                continue
            }

            # Dual-mode: stash — bare stash = mutating (push); inspect sub-subcommand
            if ($sub -eq 'stash') {
                $op = Get-FirstPositional $tokens $next
                if ($null -eq $op) {
                    return "Blocked: bare 'git stash' is a write operation (equivalent to stash push)"
                }
                if ($STASH_BLOCK -contains $op) {
                    return "Blocked: 'git stash $op' is a write operation"
                }
                # list, show, or unrecognized sub-subcommand → allow (fail-open)
                $atStart = $false
                $i = $next
                continue
            }

            # Dual-mode: worktree — list is read-only; all others are mutating
            if ($sub -eq 'worktree') {
                $op = Get-FirstPositional $tokens $next
                if ($null -ne $op -and ($WORKTREE_BLOCK -contains $op)) {
                    return "Blocked: 'git worktree $op' is a write operation"
                }
                $atStart = $false
                $i = $next
                continue
            }

            # Dual-mode: remote — bare/-v/show/get-url are read-only; others mutating
            if ($sub -eq 'remote') {
                $op = Get-FirstPositional $tokens $next
                if ($null -ne $op -and ($REMOTE_BLOCK -contains $op)) {
                    return "Blocked: 'git remote $op' is a write operation"
                }
                $atStart = $false
                $i = $next
                continue
            }

            # Dual-mode: notes — list/show are read-only; others mutating
            if ($sub -eq 'notes') {
                $op = Get-FirstPositional $tokens $next
                if ($null -ne $op -and ($NOTES_BLOCK -contains $op)) {
                    return "Blocked: 'git notes $op' is a write operation"
                }
                $atStart = $false
                $i = $next
                continue
            }

            # Default: ALLOW — status, diff, log, show, blame, reflog, rev-parse,
            # describe, ls-files, ls-tree, cat-file, shortlog, grep, config --get, etc.
            $atStart = $false
            $i = $next
            continue
        }

        # Non-git token or non-statement-start position
        $atStart = $false
        $i++
    }

    return $null
}

# ---------------------------------------------------------------------------
# Entry point — outer try/catch ensures fail-open on any unexpected error
# ---------------------------------------------------------------------------

try {
    $inputText = [Console]::In.ReadToEnd()

    if ([string]::IsNullOrWhiteSpace($inputText)) { exit 0 }

    $payload = $null
    try {
        $payload = $inputText | ConvertFrom-Json -ErrorAction Stop
    } catch {
        exit 0  # not parseable JSON — fail open
    }

    if ($null -eq $payload) { exit 0 }

    # tool_name check — $null -ne 'Bash' is $true, so a missing field safely exits 0
    if ($payload.tool_name -ne 'Bash') { exit 0 }

    $toolInput = $payload.tool_input
    if ($null -eq $toolInput) { exit 0 }

    $cmd = $toolInput.command
    if ($null -eq $cmd -or [string]::IsNullOrEmpty([string]$cmd)) { exit 0 }

    $reason = Find-GitWrite ([string]$cmd)
    if ($null -ne $reason) {
        [Console]::Error.WriteLine($reason)
        exit 2
    }

    exit 0
} catch {
    exit 0  # any unexpected error — fail open
}
