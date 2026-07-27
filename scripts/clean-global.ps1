<#
.SYNOPSIS
    One-time migration: removes stale sync-global.ps1-deployed agent/rule/
    skill copies from ~/.claude/ so a plugin install (conductor, etc.)
    takes over resolution instead of being silently shadowed by them.
.DESCRIPTION
    Plugin agents/skills resolve last, so a stale ~/.claude/agents/*.md (or
    rules/skills equivalent) silently wins over same-named plugin content
    forever. Canon names come from plugins/*/ (agents/skills are authored
    there; the two rules filenames no longer exist as files - inlined into
    plugins/conductor/agents/main.md's Operating Rules section - so they're
    hardcoded below). Only name-matched items under <Destination>/{agents,
    rules,skills} are backed up then removed; foreign items, settings.json,
    agent-memory/, and plugins/ are never touched.
.PARAMETER DryRun
    Print what would be backed up/removed without making changes.
.PARAMETER Destination
    Target ~/.claude-equivalent dir to clean (default ~/.claude). Exists so
    this script is testable against a scratch directory.
#>
param(
    [switch]$DryRun,
    [string]$Destination = (Join-Path ([System.Environment]::GetFolderPath('UserProfile')) '.claude')
)

# This repo's tooling requires PowerShell 7 Core (pwsh) on both macOS and Windows.
# Windows PowerShell 5.1 (powershell.exe) is not supported.
if ($PSVersionTable.PSVersion.Major -lt 7 -or $PSVersionTable.PSEdition -ne 'Core') {
    Write-Error "This script requires PowerShell 7 Core (pwsh) - Windows PowerShell 5.1 (powershell.exe) is not supported. Detected: PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition) edition). Re-run with: pwsh $PSCommandPath"
    exit 1
}

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# $PSScriptRoot already IS scripts/, so one Split-Path lands at repo root
# (agent-memory: scripts-project-root-resolution).
$PluginsRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'plugins'
$ManagedDirs = @('agents', 'rules', 'skills')
$removedCount = 0
$preservedCount = 0

# $true if $Path is a symlink/junction; -Force stats the reparse point itself.
function Test-ReparsePoint {
    param([string]$Path)
    $item = Get-Item -Force -ErrorAction SilentlyContinue -Path $Path
    return ($null -ne $item) -and [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
}

# Canon leaf names this repo ships for one managed subdir, sourced from
# plugins/*/ now that .claude/{agents,rules,skills} no longer exist.
function Get-CanonNames {
    param([string]$SubDir)
    if ($SubDir -eq 'agents') {
        $p = Join-Path $PluginsRoot 'conductor/agents'
        if (-not (Test-Path $p)) { return @() }
        return @(Get-ChildItem -Path $p -File -Filter '*.md' | ForEach-Object { $_.Name })
    }
    if ($SubDir -eq 'rules') {
        # No longer files in-repo, but a stale deployed copy of either name
        # still shadows rule resolution, so they stay hardcoded here.
        return @('engineering-rules.md', 'git-hygiene.md')
    }
    if (-not (Test-Path $PluginsRoot)) { return @() }
    return @(Get-ChildItem -Path $PluginsRoot -Directory | ForEach-Object {
        $skillsPath = Join-Path $_.FullName 'skills'
        if (Test-Path $skillsPath) { Get-ChildItem -Path $skillsPath -Directory | ForEach-Object { $_.Name } }
    })
}

try {
    if (Test-ReparsePoint -Path $Destination) {
        Write-Warning "Destination '$Destination' is a symlink/junction - refusing to touch it."
        exit 1
    }
    if (-not (Test-Path $Destination)) {
        Write-Host "Nothing to clean - '$Destination' does not exist."
        exit 0
    }

    # A symlinked managed subdir is skipped entirely (no backup, no removal);
    # the root case above aborts instead, since there's no safe root at all.
    $safeDirs = @(foreach ($dir in $ManagedDirs) {
        $destSubDir = Join-Path $Destination $dir
        if (-not (Test-Path $destSubDir)) { continue }
        if (Test-ReparsePoint -Path $destSubDir) {
            Write-Warning "'$destSubDir' is a symlink/junction - skipping this directory entirely."
            continue
        }
        $dir
    })

    # --- Backup (whole subdir, foreign items included) before any removal ---
    if ($safeDirs.Count -eq 0) {
        Write-Host "No existing agents/rules/skills content under '$Destination' - nothing to back up."
    } else {
        # Collision-proof: never reuse/nest into an existing backup root.
        $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $backupRootBase = Join-Path (Split-Path -Parent $Destination) ".claude-backup-$timestamp"
        $backupRoot = $backupRootBase
        $n = 2
        while (Test-Path $backupRoot) { $backupRoot = "$backupRootBase-$n"; $n++ }
        Write-Host "Backup root: $backupRoot"
        foreach ($dir in $safeDirs) {
            $destSubDir = Join-Path $Destination $dir
            $backupSubDir = Join-Path $backupRoot $dir
            if ($DryRun) {
                Write-Host "  WOULD BACKUP  $destSubDir -> $backupSubDir"
            } else {
                New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
                Copy-Item -Path $destSubDir -Destination $backupSubDir -Recurse -Force
                Write-Host "  BACKUP  $destSubDir -> $backupSubDir"
            }
        }
    }

    # --- Name-matched removal + foreign-item preservation ---
    foreach ($dir in $safeDirs) {
        $destSubDir = Join-Path $Destination $dir
        $canonNames = Get-CanonNames -SubDir $dir
        $isSkills = $dir -eq 'skills'

        # Outer @() must wrap the whole if/else (agent-memory:
        # pwsh-strictmode-pipeline-null-count) or a single-result branch
        # collapses to a scalar and .Count throws under strict mode.
        $children = @(if ($isSkills) {
            Get-ChildItem -Path $destSubDir -Directory -ErrorAction SilentlyContinue
        } else {
            Get-ChildItem -Path $destSubDir -File -Filter '*.md' -ErrorAction SilentlyContinue
        })

        $removedInDir = 0
        foreach ($child in $children) {
            try {
                if ($canonNames -notcontains $child.Name) {
                    Write-Host "  PRESERVED (not from this repo)  $($child.FullName)"
                    $preservedCount++
                    continue
                }
                if ($DryRun) {
                    Write-Host "  WOULD REMOVE  $($child.FullName)"
                } else {
                    Remove-Item -Path $child.FullName -Recurse -Force
                    Write-Host "  REMOVED  $($child.FullName)"
                }
                $removedCount++
                $removedInDir++
            } catch {
                Write-Warning "Failed to process '$($child.FullName)': $($_.Exception.Message)"
            }
        }

        # Remove the subdir only if this run emptied it. Counts ALL items
        # (-Force, not just type-filtered $children) so a leftover wrong-type
        # item (e.g. a stray file in skills/) blocks removal in both dry-run
        # and real-run alike, keeping the two predictions in sync.
        if ((Test-Path $destSubDir) -and $removedInDir -gt 0) {
            $totalNow = @(Get-ChildItem -Path $destSubDir -Force -ErrorAction SilentlyContinue).Count
            if ($DryRun) {
                if ($totalNow -eq $removedInDir) { Write-Host "  WOULD REMOVE (now empty)  $destSubDir" }
            } elseif ($totalNow -eq 0) {
                Remove-Item -Path $destSubDir -Force
                Write-Host "  REMOVED (now empty)  $destSubDir"
            }
        }
    }

    $doneSuffix = if ($DryRun) { ' (dry run)' } else { '' }
    Write-Host "`nDone$doneSuffix. Removed $removedCount, preserved $preservedCount."
} catch {
    Write-Error "Catastrophic failure: $($_.Exception.Message)"
    exit 1
}
