<#
.SYNOPSIS
    Syncs .claude/settings.json from the project repo into the global user
    settings file.
.DESCRIPTION
    Plugins-as-source-of-truth: agents, rules, and skills are authored in
    claude/plugins/*/ and delivered by installing the plugin, so this script no
    longer copies those subdirs. Its one remaining job is the repo-authoritative
    merge of settings.json into ~/.claude/settings.json - repo wins on every key
    except the ones named in $SettingsPreserveKeys (model, tui, enabledPlugins,
    extraKnownMarketplaces, agent), which survive from the deployed copy instead
    - settings.json is never clean-replaced since Claude Code rewrites
    machine-local state into it at runtime. MCP servers now travel inside each product plugin's own
    .mcp.json (claude/plugins/conductor/.mcp.json, claude/plugins/refuter/.mcp.json),
    delivered by the plugin itself, so this script no longer registers them.
.PARAMETER DryRun
    Print what would be written without making changes.
#>
param(
    [switch]$DryRun
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

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$UserHome = [System.Environment]::GetFolderPath('UserProfile')

# Machine-local keys that live only in the deployed settings.json and must survive
# the sync even though the repo copy is otherwise authoritative (repo wins on
# everything else, including deletions). Extend this list as new machine-local
# settings keys are introduced.
# 'extraKnownMarketplaces' is preserved because this repo's own .claude/settings.json
# used to register its own marketplace with a RELATIVE path for dogfooding (the
# marketplace now lives in claude/ and is registered per machine via /plugin); a
# relative entry only resolves from this repo's directory, so the deployed
# (global) value must win here rather than syncing the repo's relative path verbatim.
# 'agent' is preserved so set-default-agent-global.ps1's product choice (the
# top-level "agent" key) survives a later sync-global run instead of being
# reverted to whatever (or nothing) the repo's own settings.json carries.
$SettingsPreserveKeys = @('model', 'tui', 'enabledPlugins', 'extraKnownMarketplaces', 'agent')

function ConvertTo-Hashtable {
    param([Parameter(ValueFromPipeline)]$InputObject)
    process {
        if ($null -eq $InputObject) { return $null }
        if ($InputObject -is [System.Collections.IEnumerable] -and $InputObject -isnot [string]) {
            $col = @(); foreach ($i in $InputObject) { $col += ConvertTo-Hashtable $i }
            return ,$col
        }
        if ($InputObject -is [PSCustomObject]) {
            $h = @{}
            foreach ($p in $InputObject.PSObject.Properties) { $h[$p.Name] = ConvertTo-Hashtable $p.Value }
            return $h
        }
        return $InputObject
    }
}

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
    $merged = Get-Content -Raw -Path $Source | ConvertFrom-Json | ConvertTo-Hashtable

    # Carry over only the preserve-listed machine-local keys from the deployed copy.
    if (Test-Path $Destination) {
        $deployed = Get-Content -Raw -Path $Destination | ConvertFrom-Json | ConvertTo-Hashtable
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

# --- .claude/settings.json ---
$srcSettings  = Join-Path $ProjectRoot '.claude' 'settings.json'
$destSettings = Join-Path $UserHome '.claude' 'settings.json'
Write-Host "`n[settings.json] $srcSettings -> $destSettings"
Merge-JsonRepoAuthoritative -Source $srcSettings -Destination $destSettings -PreserveKeys $SettingsPreserveKeys

$doneSuffix = if ($DryRun) { ' (dry run)' } else { '' }
Write-Host "`nDone$doneSuffix."
