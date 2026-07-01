<#
.SYNOPSIS
    Syncs .claude from the project repo into the global user home folder.
.DESCRIPTION
    Clean-replaces agents, rules, and skills subdirs in ~/.claude/ from the project.
    Each synced subdir is removed then re-copied so deleted source files don't persist.
.PARAMETER DryRun
    Print what would be copied without making changes.
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

function Sync-SettingsJson {
    param(
        [string]$Source,
        [string]$Destination
    )

    if (-not (Test-Path $Source)) {
        Write-Host "  SKIP  $Source (not found)"
        return
    }

    # Repo settings.json is authoritative, including deletions: start from it as-is.
    $merged = Get-Content -Raw -Path $Source | ConvertFrom-Json -AsHashtable

    # Carry over only the preserve-listed machine-local keys from the deployed copy.
    if (Test-Path $Destination) {
        $deployed = Get-Content -Raw -Path $Destination | ConvertFrom-Json -AsHashtable
        foreach ($key in $SettingsPreserveKeys) {
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

# --- .claude ---
$srcClaude  = Join-Path $ProjectRoot '.claude'
$destClaude = Join-Path $UserHome '.claude'
Write-Host "`n[.claude] $srcClaude -> $destClaude"
# Only merge known content subdirs; never touch sessions, cache, credentials, etc.
Sync-Folder -Source $srcClaude -Destination $destClaude -SubDirs @('agents', 'rules', 'skills')
Sync-SettingsJson -Source (Join-Path $srcClaude 'settings.json') -Destination (Join-Path $destClaude 'settings.json')

Write-Host "`nDone$(if ($DryRun) { ' (dry run)' })."
