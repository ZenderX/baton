<#
.SYNOPSIS
    Syncs .claude from the project repo into the global user home folder.
.DESCRIPTION
    Clean-replaces agents, rules, and skills subdirs in ~/.claude/ from the project.
    Each synced subdir is removed then re-copied so deleted source files don't persist.
    settings.json and the Obsidian graph.json are repo-authoritative merges instead
    (a small preserve-list of machine-local keys survives from the deployed copy) -
    these files are never clean-replaced since Obsidian/Claude Code rewrite
    machine-local state into them at runtime.
    Finally, registers each MCP server from the project's .mcp.json into Claude
    Code's user scope by shelling out to `claude mcp add-json` (never writes
    ~/.claude.json directly).
.PARAMETER DryRun
    Print what would be copied/written/run without making changes.
#>
param(
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$UserHome = [System.Environment]::GetFolderPath('UserProfile')

function Sync-Folder {
    param(
        [string]$Source,
        [string]$Destination,
        [string[]]$SubDirs   # if specified, clean-replace these subdirs; otherwise clean-replace root
    )

    if (-not (Test-Path $Source)) {
        Write-Host "  SKIP  $Source (not found)"
        return
    }

    $items = if ($SubDirs) {
        $SubDirs | ForEach-Object { Join-Path $Source $_ } | Where-Object { Test-Path $_ }
    } else {
        @($Source)
    }

    foreach ($item in $items) {
        $relBase = if ($SubDirs) { Split-Path -Leaf $item } else { '' }
        $destRoot = if ($relBase) { Join-Path $Destination $relBase } else { $Destination }

        # Clean destination before copying so deleted source files don't persist
        if ($DryRun) {
            Write-Host "  WOULD CLEAN $destRoot"
        } elseif (Test-Path $destRoot) {
            Remove-Item -Path $destRoot -Recurse -Force
            Write-Host "  CLEANED  $destRoot"
        }

        Get-ChildItem -Path $item -Recurse -File | ForEach-Object {
            $rel = $_.FullName.Substring($item.Length).TrimStart([IO.Path]::DirectorySeparatorChar, '/')
            $dest = if ($relBase) {
                Join-Path (Join-Path $Destination $relBase) $rel
            } else {
                Join-Path $Destination $rel
            }

            $destDir = Split-Path $dest
            if ($DryRun) {
                Write-Host "  WOULD COPY  $($_.FullName)"
                Write-Host "           -> $dest"
            } else {
                if (-not (Test-Path $destDir)) {
                    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
                }
                Copy-Item -Path $_.FullName -Destination $dest -Force
                Write-Host "  COPIED  $($_.FullName.Substring($ProjectRoot.Length + 1)) -> $dest"
            }
        }
    }
}

# Machine-local keys that live only in the deployed settings.json and must survive
# the sync even though the repo copy is otherwise authoritative (repo wins on
# everything else, including deletions). Extend this list as new machine-local
# settings keys are introduced.
$SettingsPreserveKeys = @('model', 'tui', 'enabledPlugins')

# Machine-local Obsidian graph view-state keys (force-layout tuning, panel
# collapse state, zoom) that live only on the deployed graph.json and must
# survive the sync. Repo wins on everything else (colorGroups, search, display
# toggles, and any new keys), including deletions.
$GraphPreserveKeys = @(
    'collapse-filter', 'collapse-color-groups', 'collapse-display', 'collapse-forces',
    'centerStrength', 'repelStrength', 'linkStrength', 'linkDistance',
    'scale', 'close', 'textFadeMultiplier', 'nodeSizeMultiplier'
)

function Merge-JsonRepoAuthoritative {
    param(
        [string]$Source,
        [string]$Destination,
        [string[]]$PreserveKeys
    )

    if (-not (Test-Path $Source)) {
        Write-Host "  SKIP  $Source (not found)"
        return
    }

    # Repo copy is authoritative, including deletions: start from it as-is.
    $merged = Get-Content -Raw -Path $Source | ConvertFrom-Json -AsHashtable

    # Carry over only the preserve-listed machine-local keys from the deployed copy.
    if (Test-Path $Destination) {
        $deployed = Get-Content -Raw -Path $Destination | ConvertFrom-Json -AsHashtable
        foreach ($key in $PreserveKeys) {
            if ($deployed.ContainsKey($key)) {
                $merged[$key] = $deployed[$key]
            }
        }
    }

    $json = $merged | ConvertTo-Json -Depth 10

    if ($DryRun) {
        Write-Host "  WOULD WRITE  $Source"
        Write-Host "            -> $Destination"
    } else {
        $destDir = Split-Path $Destination
        if (-not (Test-Path $destDir)) {
            New-Item -ItemType Directory -Path $destDir -Force | Out-Null
        }
        Set-Content -Path $Destination -Value $json
        Write-Host "  WROTE  $($Source.Substring($ProjectRoot.Length + 1)) -> $Destination"
    }
}

# Registers each server defined in the repo's .mcp.json into Claude Code's
# user scope via `claude mcp add-json`, rather than writing ~/.claude.json
# directly (it bundles OAuth/session/trust state and scripted writes to it
# have documented corruption issues - see anthropics/claude-code#29056).
# `add-json` is NOT idempotent: it has no --force/update flag and exits 1 if
# a same-name entry already exists in user scope. To make re-runs idempotent,
# this function removes any existing user-scope entry first, then adds it
# fresh (remove exits 1 when absent, which is expected and ignored). Note: a
# project .mcp.json with a same-named server shadows the user-scope entry
# entirely (precedence: local > project > user), so this registration is a
# fallback baseline, not the active config, whenever a project-level
# .mcp.json is also present.
function Sync-McpServers {
    param(
        [string]$Source
    )

    if (-not (Test-Path $Source)) {
        Write-Host "  SKIP  $Source (not found)"
        return $true
    }

    if (-not (Get-Command 'claude' -ErrorAction SilentlyContinue)) {
        Write-Host "  SKIP  claude CLI not found on PATH; cannot register MCP servers"
        return $true
    }

    $config = Get-Content -Raw -Path $Source | ConvertFrom-Json -AsHashtable
    $servers = $config['mcpServers']
    if (-not $servers -or $servers.Count -eq 0) {
        Write-Host "  SKIP  $Source (no mcpServers defined)"
        return $true
    }

    $allSucceeded = $true
    foreach ($name in $servers.Keys) {
        $serverJson = $servers[$name] | ConvertTo-Json -Depth 10 -Compress
        $cmdDisplay = "claude mcp add-json $name '$serverJson' --scope user"

        if ($DryRun) {
            Write-Host "  WOULD RUN  claude mcp remove $name --scope user"
            Write-Host "  WOULD RUN  $cmdDisplay"
            continue
        }

        # add-json errors (exit 1) if a same-name user-scope entry already exists and
        # offers no --force/update flag, so remove any existing one first to make
        # re-runs idempotent. remove exits 1 when absent - intentionally ignored.
        & claude mcp remove $name --scope user 2>&1 | Out-Null

        try {
            $output = & claude mcp add-json $name $serverJson --scope user 2>&1
            $exitCode = $LASTEXITCODE
        } catch {
            $output = $_.Exception.Message
            $exitCode = 1
        }

        if ($exitCode -ne 0) {
            Write-Host "  FAILED  mcp add-json for '$name' (exit $exitCode):"
            $output | ForEach-Object { Write-Host "    $_" }
            $allSucceeded = $false
        } else {
            Write-Host "  REGISTERED  $name -> user scope"
        }
    }

    return $allSucceeded
}

# --- .claude ---
$srcClaude  = Join-Path $ProjectRoot '.claude'
$destClaude = Join-Path $UserHome '.claude'
Write-Host "`n[.claude] $srcClaude -> $destClaude"
# Only merge known content subdirs; never touch sessions, cache, credentials, etc.
Sync-Folder -Source $srcClaude -Destination $destClaude -SubDirs @('agents', 'rules', 'skills')
Merge-JsonRepoAuthoritative -Source (Join-Path $srcClaude 'settings.json') -Destination (Join-Path $destClaude 'settings.json') -PreserveKeys $SettingsPreserveKeys

# --- Obsidian graph.json (view-state merge; .obsidian dir is never clean-replaced -
# once the vault is opened, Obsidian writes its own workspace.json/app.json/etc.
# there and live-rewrites graph.json UI state) ---
$srcGraph  = Join-Path $srcClaude 'agent-memory/.obsidian/graph.json'
$destGraph = Join-Path $destClaude 'agent-memory/.obsidian/graph.json'
Write-Host "`n[graph.json] $srcGraph -> $destGraph"
Merge-JsonRepoAuthoritative -Source $srcGraph -Destination $destGraph -PreserveKeys $GraphPreserveKeys

# --- MCP servers (user scope) ---
$srcMcp = Join-Path $ProjectRoot '.mcp.json'
Write-Host "`n[.mcp.json] $srcMcp -> user scope (via claude CLI)"
$mcpSucceeded = Sync-McpServers -Source $srcMcp

$doneSuffix = if ($DryRun) { ' (dry run)' } else { '' }
if ($mcpSucceeded) {
    Write-Host "`nDone$doneSuffix."
} else {
    Write-Host "`nDone$doneSuffix, with MCP registration failures (see FAILED lines above)."
}
