<#
.SYNOPSIS
    Builds distributable plugin artifacts under plugins/<name>/ from the canonical
    .claude/{agents,skills} and root .mcp.json.
.DESCRIPTION
    Clean-replaces each plugin's agents/ and skills/ subdirs (and, for conductor-core,
    .mcp.json and hooks/rules.md) per the $PluginManifest table below, mirroring
    sync-global.ps1's clean-replace-then-copy idiom. Deleted/renamed source files do
    not persist in plugin output; re-running is idempotent.
    Only agents/, skills/, .mcp.json, and hooks/rules.md are managed here. Each
    plugin's .claude-plugin/plugin.json is authored by hand (Phase 1) and is never
    touched by this script. hooks/hooks.json (added later, alongside rules.md) is
    also left alone - only the single rules.md file inside hooks/ is generated.
    This script is a sibling to sync-global.ps1, not a modification of it:
    "deploy to my machine" (sync-global.ps1) and "build distributable plugin
    artifacts" (this script) are decoupled concerns that happen to share a source
    tree and a copy idiom, nothing else.
.PARAMETER DryRun
    Print what would be cleaned/copied/written without making changes.
#>
param(
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Single parent-of-script-dir resolution: $PSScriptRoot already equals the scripts/
# dir, so one Split-Path -Parent call lands at the repo root (see
# .claude/agent-memory/implement-subagent/scripts-project-root-resolution.md).
$ProjectRoot = Split-Path -Parent $PSScriptRoot

$ClaudeAgentsRoot = Join-Path $ProjectRoot '.claude/agents'
$ClaudeSkillsRoot = Join-Path $ProjectRoot '.claude/skills'
$RootMcp = Join-Path $ProjectRoot '.mcp.json'
$RulesFiles = @(
    Join-Path $ProjectRoot '.claude/rules/engineering-rules.md'
    Join-Path $ProjectRoot '.claude/rules/git-hygiene.md'
)

# Per-plugin manifest: which canonical content lands in which plugins/<name>/ tree.
# AllAgents=$true mirrors the entire .claude/agents/ dir (conductor-core ships every
# agent); AllAgents=$false means this plugin carries no agents at all (any stray
# agents/ dir found there is removed for clean-replace consistency). Skills are
# always an explicit subset - no plugin ships the full .claude/skills/ set.
$PluginManifest = [ordered]@{
    'conductor-core'  = @{
        AllAgents = $true
        Skills    = @('bevy', 'git-diff', 'memory-review', 'memory-write', 'obsidian-links', 'rust', 'typescript', 'vue3')
        Mcp       = $true
        RulesHook = $true
    }
    'bevy'            = @{
        AllAgents = $false
        Skills    = @('bevy')
        Mcp       = $false
        RulesHook = $false
    }
    'blender'         = @{
        AllAgents = $false
        Skills    = @('blender')
        Mcp       = $false
        RulesHook = $false
    }
    'rust'            = @{
        AllAgents = $false
        Skills    = @('rust')
        Mcp       = $false
        RulesHook = $false
    }
    'typescript'      = @{
        AllAgents = $false
        Skills    = @('typescript')
        Mcp       = $false
        RulesHook = $false
    }
    'vue3'            = @{
        AllAgents = $false
        Skills    = @('vue3')
        Mcp       = $false
        RulesHook = $false
    }
}

# Detects symlinks/junctions/reparse points so no clean-replace target is ever
# followed through to an attacker/externally-controlled location. Must be checked
# before every read or mutation of a managed path (see
# .claude/agent-memory/implement-subagent/hook-safe-pwsh-scripts.md).
function Test-ReparsePoint {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    return [bool]($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint))
}

# Throws if $Path exists and is a reparse point; call before any clean/copy/write.
function Assert-NotReparsePoint {
    param([string]$Path, [string]$Label)
    if (Test-ReparsePoint -Path $Path) {
        throw "Refusing to touch '$Label' at '$Path': it is a symlink/reparse point, not a real file/directory."
    }
}

# Clean-replaces $DestDir with a full recursive mirror of $SourceDir (used for the
# agents/ subdir, which is always all-or-nothing per plugin).
function Sync-PluginTree {
    param([string]$SourceDir, [string]$DestDir, [string]$Label)

    Assert-NotReparsePoint -Path $DestDir -Label $Label

    if ($DryRun) {
        Write-Host "  WOULD CLEAN  $DestDir"
    } elseif (Test-Path $DestDir) {
        Remove-Item -Path $DestDir -Recurse -Force
        Write-Host "  CLEANED  $DestDir"
    }

    if (-not (Test-Path $SourceDir)) {
        Write-Host "  SKIP  $SourceDir (not found)"
        return
    }

    Get-ChildItem -Path $SourceDir -Recurse -File | ForEach-Object {
        try {
            $rel = $_.FullName.Substring($SourceDir.Length).TrimStart([IO.Path]::DirectorySeparatorChar, '/')
            $dest = Join-Path $DestDir $rel
            $destParent = Split-Path $dest
            if ($DryRun) {
                Write-Host "  WOULD COPY  $($_.FullName)"
                Write-Host "           -> $dest"
            } else {
                if (-not (Test-Path $destParent)) { New-Item -ItemType Directory -Path $destParent -Force | Out-Null }
                Copy-Item -Path $_.FullName -Destination $dest -Force
                Write-Host "  COPIED  $rel -> $dest"
            }
        } catch {
            Write-Warning "  FAILED copying $($_.FullName): $($_.Exception.Message)"
        }
    }
}

# Clean-replaces $DestDir, then copies only the named skill subdirectories from
# $SkillsSourceRoot (skills are always an explicit subset, never the full set).
function Sync-PluginSkills {
    param([string]$SkillsSourceRoot, [string]$DestDir, [string[]]$SkillNames, [string]$Label)

    Assert-NotReparsePoint -Path $DestDir -Label $Label

    if ($DryRun) {
        Write-Host "  WOULD CLEAN  $DestDir"
    } elseif (Test-Path $DestDir) {
        Remove-Item -Path $DestDir -Recurse -Force
        Write-Host "  CLEANED  $DestDir"
    }

    foreach ($skill in $SkillNames) {
        try {
            $src = Join-Path $SkillsSourceRoot $skill
            if (-not (Test-Path $src)) {
                Write-Warning "  MISSING source skill '$skill' at $src - skipped"
                continue
            }
            $destSkillDir = Join-Path $DestDir $skill
            Get-ChildItem -Path $src -Recurse -File | ForEach-Object {
                $rel = $_.FullName.Substring($src.Length).TrimStart([IO.Path]::DirectorySeparatorChar, '/')
                $dest = Join-Path $destSkillDir $rel
                $destParent = Split-Path $dest
                if ($DryRun) {
                    Write-Host "  WOULD COPY  $($_.FullName)"
                    Write-Host "           -> $dest"
                } else {
                    if (-not (Test-Path $destParent)) { New-Item -ItemType Directory -Path $destParent -Force | Out-Null }
                    Copy-Item -Path $_.FullName -Destination $dest -Force
                    Write-Host "  COPIED  $skill/$rel -> $dest"
                }
            }
        } catch {
            Write-Warning "  FAILED copying skill '$skill': $($_.Exception.Message)"
        }
    }
}

# Concatenates the two canonical rules files into plugins/conductor-core/hooks/rules.md
# so the Phase 4 SessionStart hook has generated (never hand-duplicated) content to
# emit as additionalContext. Only this single file is managed inside hooks/ - the
# rest of that directory (hooks.json, added later) is left untouched.
function Write-RulesHookContent {
    param([string[]]$SourceFiles, [string]$HooksDir, [string]$Label)

    if (Test-Path $HooksDir) { Assert-NotReparsePoint -Path $HooksDir -Label $Label }
    $rulesDest = Join-Path $HooksDir 'rules.md'
    if (Test-Path $rulesDest) { Assert-NotReparsePoint -Path $rulesDest -Label "$Label/rules.md" }

    $missing = $SourceFiles | Where-Object { -not (Test-Path $_) }
    if ($missing) {
        Write-Warning "  MISSING rules source file(s): $($missing -join ', ') - skipping rules.md generation"
        return
    }

    $header = "<!-- AUTO-GENERATED by scripts/build-plugins.ps1 from .claude/rules/*.md - do not edit directly -->`n`n"
    $body = ($SourceFiles | ForEach-Object { Get-Content -Raw -Path $_ }) -join "`n---`n`n"
    $content = $header + $body

    if ($DryRun) {
        Write-Host "  WOULD WRITE  $rulesDest"
    } else {
        if (-not (Test-Path $HooksDir)) { New-Item -ItemType Directory -Path $HooksDir -Force | Out-Null }
        Set-Content -Path $rulesDest -Value $content -NoNewline
        Write-Host "  WROTE  $rulesDest"
    }
}

try {
    foreach ($pluginName in $PluginManifest.Keys) {
        $cfg = $PluginManifest[$pluginName]
        $pluginRoot = Join-Path $ProjectRoot "plugins/$pluginName"
        Write-Host "`n[$pluginName] $pluginRoot"

        if (-not (Test-Path $pluginRoot)) {
            Write-Warning "  Plugin root '$pluginRoot' does not exist (expected .claude-plugin/plugin.json already in place) - skipping"
            continue
        }
        Assert-NotReparsePoint -Path $pluginRoot -Label "plugin root ($pluginName)"

        # Agents: whole-mirror if this plugin ships all of them, otherwise remove
        # any stray agents/ dir so "no agents" stays true after a clean-replace.
        $agentsDest = Join-Path $pluginRoot 'agents'
        try {
            if ($cfg.AllAgents) {
                Sync-PluginTree -SourceDir $ClaudeAgentsRoot -DestDir $agentsDest -Label "$pluginName/agents"
            } elseif (Test-Path $agentsDest) {
                Assert-NotReparsePoint -Path $agentsDest -Label "$pluginName/agents"
                if ($DryRun) {
                    Write-Host "  WOULD REMOVE  $agentsDest (no agents in this plugin)"
                } else {
                    Remove-Item -Path $agentsDest -Recurse -Force
                    Write-Host "  REMOVED  $agentsDest (no agents in this plugin)"
                }
            }
        } catch {
            Write-Warning "  FAILED agents sync for '$pluginName': $($_.Exception.Message)"
        }

        # Skills: always an explicit subset of .claude/skills/.
        $skillsDest = Join-Path $pluginRoot 'skills'
        try {
            Sync-PluginSkills -SkillsSourceRoot $ClaudeSkillsRoot -DestDir $skillsDest -SkillNames $cfg.Skills -Label "$pluginName/skills"
        } catch {
            Write-Warning "  FAILED skills sync for '$pluginName': $($_.Exception.Message)"
        }

        # .mcp.json: single-file copy, conductor-core only.
        if ($cfg.Mcp) {
            try {
                $mcpDest = Join-Path $pluginRoot '.mcp.json'
                if (Test-Path $mcpDest) { Assert-NotReparsePoint -Path $mcpDest -Label "$pluginName/.mcp.json" }
                if ($DryRun) {
                    Write-Host "  WOULD COPY  $RootMcp"
                    Write-Host "           -> $mcpDest"
                } else {
                    Copy-Item -Path $RootMcp -Destination $mcpDest -Force
                    Write-Host "  COPIED  .mcp.json -> $mcpDest"
                }
            } catch {
                Write-Warning "  FAILED .mcp.json copy for '$pluginName': $($_.Exception.Message)"
            }
        }

        # hooks/rules.md: generated content, conductor-core only.
        if ($cfg.RulesHook) {
            try {
                $hooksDest = Join-Path $pluginRoot 'hooks'
                Write-RulesHookContent -SourceFiles $RulesFiles -HooksDir $hooksDest -Label "$pluginName/hooks"
            } catch {
                Write-Warning "  FAILED rules.md generation for '$pluginName': $($_.Exception.Message)"
            }
        }
    }

    $doneSuffix = if ($DryRun) { ' (dry run)' } else { '' }
    Write-Host "`nDone$doneSuffix."
} catch {
    Write-Error "build-plugins.ps1 failed: $($_.Exception.Message)"
    exit 1
}
