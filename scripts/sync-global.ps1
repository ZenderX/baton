<#
.SYNOPSIS
    Syncs .claude and .github from the project repo into the global user home folders.
.DESCRIPTION
    Merges project .claude/ into ~/.claude/ (agents, rules, skills subdirs only).
    Merges project .github/ into ~/.github/ if the project folder exists.
    Existing files in the destination are overwritten; unrelated files are left untouched.
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
        [string[]]$SubDirs   # if specified, only sync these subdirs; otherwise sync all files
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

        Get-ChildItem -Path $item -Recurse -File | ForEach-Object {
            $rel = $_.FullName.Substring($item.Length).TrimStart([IO.Path]::DirectorySeparatorChar, '/')
            $dest = if ($relBase) {
                Join-Path $Destination $relBase $rel
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

# --- .github ---
$srcGithub  = Join-Path $ProjectRoot '.github'
$destGithub = Join-Path $UserHome '.github'
if (Test-Path $srcGithub) {
    Write-Host "`n[.github] $srcGithub -> $destGithub"
    Sync-Folder -Source $srcGithub -Destination $destGithub
} else {
    Write-Host "`n[.github] No project .github folder found — skipping."
}

Write-Host "`nDone$(if ($DryRun) { ' (dry run)' })."
