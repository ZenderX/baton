# Syncs agent body content from .claude/agents/ (canonical) to .github/agents/.
# The .github/ files keep their own frontmatter; only the body is replaced.
#
# Usage: pwsh scripts/sync-agents.ps1

$root = Split-Path $PSScriptRoot
$claudeDir = Join-Path $root '.claude/agents'
$githubDir = Join-Path $root '.github/agents'

function Get-Frontmatter([string[]]$lines) {
    $count = 0
    foreach ($line in $lines) {
        if ($line -eq '---') { $count++; continue }
        if ($count -eq 1) { $line }
        if ($count -ge 2) { break }
    }
}

function Get-Body([string[]]$lines) {
    $count = 0
    foreach ($line in $lines) {
        if ($line -eq '---') { $count++; continue }
        if ($count -ge 2) { $line }
    }
}

foreach ($claudeFile in Get-ChildItem -Path $claudeDir -Filter '*.md') {
    $name = $claudeFile.BaseName
    $githubFile = Join-Path $githubDir "$name.agent.md"

    if (-not (Test-Path $githubFile)) {
        Write-Warning "No GitHub agent file for '$name' — skipping"
        continue
    }

    $frontmatter = [string[]](Get-Frontmatter (Get-Content $githubFile))
    $body        = [string[]](Get-Body        (Get-Content $claudeFile.FullName))
    $output      = @('---') + $frontmatter + @('---', '') + $body

    Set-Content -Path $githubFile -Value $output -Encoding utf8NoBOM

    Write-Host "Synced: $name"
}

Write-Host 'Done.'
