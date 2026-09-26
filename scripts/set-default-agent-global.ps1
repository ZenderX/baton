<#
.SYNOPSIS
    Sets the default agent in ~/.claude/settings.json to conductor:main or
    refuter:main, preserving every other setting already in the file.
.DESCRIPTION
    Claude Code reads the top-level "agent" key of settings.json to pick the
    agent a session starts in; this script sets it without disturbing the rest
    of the file. The whole document is round-tripped through ConvertFrom-Json /
    ConvertTo-Json, so nested keys (env, permissions.deny, statusLine, ...)
    survive but the file is reformatted on write - the same trade sync-global.ps1
    already makes on this file. A missing settings.json is created containing
    just the agent key; an already-correct one is left untouched.
.PARAMETER Agent
    Agent identifier to write: 'conductor:main' (default) or 'refuter:main'.
.PARAMETER DryRun
    Print what would be written without making changes.
.PARAMETER Destination
    Target ~/.claude-equivalent dir holding settings.json (default ~/.claude).
    Exists so this script is testable against a scratch directory.
#>
param(
    [ValidateSet('conductor:main', 'refuter:main', IgnoreCase = $false)]
    [string]$Agent = 'conductor:main',
    [switch]$DryRun,
    [string]$Destination = (Join-Path ([System.Environment]::GetFolderPath('UserProfile')) '.claude')
)

# This repo's tooling requires PowerShell 7 Core (pwsh) on both macOS and Windows.
# Windows PowerShell 5.1 (powershell.exe) is not supported: it lacks the PS7 default
# BOM-free UTF-8 encoding this script's Set-Content call relies on.
if ($PSVersionTable.PSVersion.Major -lt 7 -or $PSVersionTable.PSEdition -ne 'Core') {
    Write-Error "This script requires PowerShell 7 Core (pwsh) - Windows PowerShell 5.1 (powershell.exe) is not supported. Detected: PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition) edition). Re-run with: pwsh $PSCommandPath"
    exit 1
}

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$SettingsPath = Join-Path $Destination 'settings.json'

try {
    if (Test-Path $SettingsPath) {
        $raw = Get-Content -Raw -Path $SettingsPath
        # Get-Content -Raw yields $null for a 0-byte file, which ConvertFrom-Json rejects.
        if ([string]::IsNullOrWhiteSpace($raw)) {
            $settings = [PSCustomObject]@{}
        } else {
            $settings = $raw | ConvertFrom-Json
        }
    } else {
        Write-Host "No settings.json at '$SettingsPath' - it will be created."
        $settings = [PSCustomObject]@{}
    }

    # Strict mode throws on reading an absent property, so probe the member list first.
    # The @() wrap matters on a property-less object, where bare .Name throws too
    # (agent-memory: pwsh-strictmode-pipeline-null-count).
    $hasAgent = @($settings.PSObject.Properties | ForEach-Object { $_.Name }) -contains 'agent'
    $current = if ($hasAgent) { $settings.agent } else { $null }

    if ($current -ceq $Agent) {
        Write-Host "Default agent already set to '$Agent' - nothing to do."
        exit 0
    }

    if ($hasAgent) {
        Write-Host "Default agent: '$current' -> '$Agent'"
    } else {
        Write-Host "Default agent: (unset) -> '$Agent'"
    }

    # -Force covers both the add and the overwrite case in one call.
    $settings | Add-Member -NotePropertyName 'agent' -NotePropertyValue $Agent -Force

    # -Depth 100 so deeply nested settings (permissions, statusLine, ...) are not
    # truncated to the "System.Object[]" placeholder ConvertTo-Json emits past its depth.
    $json = $settings | ConvertTo-Json -Depth 100

    if ($DryRun) {
        Write-Host "  WOULD WRITE  $SettingsPath"
    } else {
        if (-not (Test-Path $Destination)) {
            New-Item -ItemType Directory -Path $Destination -Force | Out-Null
        }
        Set-Content -Path $SettingsPath -Value $json
        Write-Host "  WROTE  $SettingsPath"
    }

    $doneSuffix = if ($DryRun) { ' (dry run)' } else { '' }
    Write-Host "`nDone$doneSuffix."
} catch {
    Write-Error "Catastrophic failure: $($_.Exception.Message)"
    exit 1
}
