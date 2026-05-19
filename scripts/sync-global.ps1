<#
.SYNOPSIS
    Syncs .claude and .github from the project repo into the global user home folders.
.DESCRIPTION
    Clean-replaces agents, rules, and skills subdirs in ~/.claude/ from the project.
    Clean-replaces ~/.github/ from the project .github/ folder if it exists.
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

# --- .claude ---
$srcClaude  = Join-Path $ProjectRoot '.claude'
$destClaude = Join-Path $UserHome '.claude'
Write-Host "`n[.claude] $srcClaude -> $destClaude"
# Only merge known content subdirs; never touch sessions, cache, credentials, etc.
Sync-Folder -Source $srcClaude -Destination $destClaude -SubDirs @('agents', 'rules', 'skills')

Write-Host "`nDone$(if ($DryRun) { ' (dry run)' })."
