#Requires -Version 7
<#
.SYNOPSIS
    Verifies that each Claude Code agent prompt and its pi counterpart carry identical shared prose.
.DESCRIPTION
    Read-only. For every pair below the script normalizes both files in memory
    (CRLF->LF, frontmatter stripped, <!-- parity:off -->...<!-- parity:on --> blocks
    dropped, tool-dialect tokens inside backticks mapped Claude Code -> pi) and compares
    the result line by line. Exits 0 when every pair matches, 1 on any drift or marker
    error.

    Known limitation: because marked blocks are discarded before comparison, prose drift
    that lives INSIDE a parity:off block is invisible to this check. Marked regions are
    maintained by hand; keep them minimal.
.EXAMPLE
    pwsh ./scripts/check-parity.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# This repo's tooling requires PowerShell 7 Core (pwsh) on both macOS and Windows.
# Windows PowerShell 5.1 (powershell.exe) is not supported.
if ($PSVersionTable.PSVersion.Major -lt 7 -or $PSVersionTable.PSEdition -ne 'Core') {
    Write-Error "This script requires PowerShell 7 Core (pwsh) - Windows PowerShell 5.1 (powershell.exe) is not supported. Detected: PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition) edition). Re-run with: pwsh $PSCommandPath"
    exit 1
}

$RepoRoot = Split-Path -Parent $PSScriptRoot

# Claude Code path <-> pi path. main.md's counterpart is an extension prompt, not an agent file.
$Pairs = @(
    @{ Name = 'code-review'; Cc = 'claude/plugins/conductor/agents/code-review.md'; Pi = 'pi/agents/code-review.md' }
    @{ Name = 'implement';   Cc = 'claude/plugins/conductor/agents/implement.md';   Pi = 'pi/agents/implement.md' }
    @{ Name = 'planning';    Cc = 'claude/plugins/conductor/agents/planning.md';    Pi = 'pi/agents/planning.md' }
    @{ Name = 'research';    Cc = 'claude/plugins/conductor/agents/research.md';    Pi = 'pi/agents/research.md' }
    @{ Name = 'memory';      Cc = 'claude/plugins/conductor/agents/memory.md';      Pi = 'pi/agents/memory.md' }
    @{ Name = 'orchestrator'; Cc = 'claude/plugins/conductor/agents/main.md';       Pi = 'pi/extensions/conductor/orchestrator.md' }
)

# Claude Code -> pi tool-dialect map, applied only to text inside inline-code spans.
# Ordered: compound forms first, so their parts are consumed before the simple entries run.
$DialectMap = [ordered]@{
    'Agent\(conductor:memory\)'                    = 'subagent(memory)'
    'mcp__plugin_conductor_sequentialthinking__sequentialthinking' = 'the-conductor__sequentialthinking_sequentialthinking'
    'conductor:memory'                             = 'memory'
    'disallowedTools'                              = 'excludeTools'
    'Agent'                                        = 'subagent'
    'Glob'                                         = 'find'
    'Read'                                         = 'read'
    'Write'                                        = 'write'
    'Edit'                                         = 'edit'
    'Bash'                                         = 'bash'
    'Grep'                                         = 'grep'
}

$MarkerOff = '<!-- parity:off -->'
$MarkerOn  = '<!-- parity:on -->'

function Remove-Frontmatter([string]$text) {
    <#
    .SYNOPSIS Drops a leading YAML frontmatter block. Files without one (pi's orchestrator
    prompt) are returned unchanged.
    #>
    $m = [regex]::Match($text, '\A---\n[\s\S]*?\n---\n?')
    if ($m.Success) { return $text.Substring($m.Length) }
    return $text
}

function Remove-MarkedBlocks([string]$text, [string]$label) {
    <#
    .SYNOPSIS Drops every parity:off..parity:on block, markers included.
    .OUTPUTS [PSCustomObject] { Lines = [string[]]; Count = <blocks dropped>; Error = <string or $null> }
    #>
    $kept   = [System.Collections.Generic.List[string]]::new()
    $inside = $false
    $count  = 0
    $lineNo = 0
    foreach ($line in ($text -split "`n")) {
        $lineNo++
        $trimmed = $line.Trim()
        if ([string]::Equals($trimmed, $MarkerOff, [System.StringComparison]::Ordinal)) {
            if ($inside) {
                return [PSCustomObject]@{ Lines = @(); Count = 0; Error = "${label}: nested '$MarkerOff' at line $lineNo (previous block never closed)" }
            }
            $inside = $true
            continue
        }
        if ([string]::Equals($trimmed, $MarkerOn, [System.StringComparison]::Ordinal)) {
            if (-not $inside) {
                return [PSCustomObject]@{ Lines = @(); Count = 0; Error = "${label}: '$MarkerOn' at line $lineNo without a matching '$MarkerOff'" }
            }
            $inside = $false
            $count++
            continue
        }
        if (-not $inside) { $kept.Add($line) }
    }
    if ($inside) {
        return [PSCustomObject]@{ Lines = @(); Count = 0; Error = "${label}: unclosed '$MarkerOff' - no matching '$MarkerOn' before end of file" }
    }
    return [PSCustomObject]@{ Lines = $kept.ToArray(); Count = $count; Error = $null }
}

function Convert-Dialect([string]$text) {
    <#
    .SYNOPSIS Rewrites Claude Code tool names to their pi spellings, inside inline-code
    spans only - a blanket substitution would corrupt surrounding prose.
    #>
    return [regex]::Replace($text, '`[^`\r\n]+`', {
        param($m)
        $span = $m.Value
        foreach ($entry in $DialectMap.GetEnumerator()) {
            $span = [regex]::Replace($span, "(?<![A-Za-z0-9_])$($entry.Key)(?![A-Za-z0-9_])", $entry.Value)
        }
        return $span
    })
}

function Get-NormalizedLines([string]$path, [string]$label) {
    <#
    .SYNOPSIS Full normalization pipeline for one file.
    .OUTPUTS [PSCustomObject] { Lines; Count; Error }
    #>
    $text = [System.IO.File]::ReadAllText($path) -replace "`r`n", "`n"
    $text = Remove-Frontmatter $text
    $result = Remove-MarkedBlocks $text $label
    if ($result.Error) { return $result }
    $lines = @($result.Lines | ForEach-Object { $_.TrimEnd() })
    while ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') {
        $lines = if ($lines.Count -eq 1) { @() } else { @($lines[0..($lines.Count - 2)]) }
    }
    return [PSCustomObject]@{ Lines = $lines; Count = $result.Count; Error = $null }
}

$failures = [System.Collections.Generic.List[string]]::new()

foreach ($pair in $Pairs) {
    $ccPath = Join-Path $RepoRoot $pair.Cc
    $piPath = Join-Path $RepoRoot $pair.Pi

    $missing = @(@($ccPath, $piPath) | Where-Object { -not (Test-Path -LiteralPath $_) })
    if ($missing.Count -gt 0) {
        foreach ($p in $missing) { $failures.Add("$($pair.Name): missing file $p") }
        continue
    }

    $cc = Get-NormalizedLines $ccPath $pair.Cc
    $pi = Get-NormalizedLines $piPath $pair.Pi

    if ($cc.Error) { $failures.Add("$($pair.Name): $($cc.Error)"); continue }
    if ($pi.Error) { $failures.Add("$($pair.Name): $($pi.Error)"); continue }

    if ($cc.Count -ne $pi.Count) {
        $failures.Add("$($pair.Name): marked-block count differs - $($pair.Cc) has $($cc.Count), $($pair.Pi) has $($pi.Count)")
        continue
    }

    $ccLines = @((Convert-Dialect ($cc.Lines -join "`n")) -split "`n")
    $piLines = @($pi.Lines)

    # Ordinal throughout: PowerShell's -eq is case-insensitive and would pass case-only drift.
    if ([string]::Equals(($ccLines -join "`n"), ($piLines -join "`n"), [System.StringComparison]::Ordinal)) { continue }

    $report = [System.Collections.Generic.List[string]]::new()
    $report.Add("$($pair.Name): shared prose differs")
    $report.Add("    cc: $($pair.Cc)")
    $report.Add("    pi: $($pair.Pi)")
    $max = [Math]::Max($ccLines.Count, $piLines.Count)
    $shown = 0
    for ($i = 0; $i -lt $max; $i++) {
        $a = if ($i -lt $ccLines.Count) { $ccLines[$i] } else { '<end of file>' }
        $b = if ($i -lt $piLines.Count) { $piLines[$i] } else { '<end of file>' }
        if ([string]::Equals($a, $b, [System.StringComparison]::Ordinal)) { continue }
        $shown++
        if ($shown -gt 10) {
            $report.Add('    ... (further differences suppressed)')
            break
        }
        # Line numbers are positions in the NORMALIZED text, not the source file.
        $report.Add("    line $($i + 1):")
        $report.Add("      - cc: $a")
        $report.Add("      + pi: $b")
    }
    $failures.Add(($report -join "`n"))
}

$sep = '=' * 64
Write-Host ''
Write-Host $sep
Write-Host ' Agent Prompt Parity Check'
Write-Host " Root  : $RepoRoot"
Write-Host " Pairs : $($Pairs.Count)"
Write-Host $sep

if ($failures.Count -gt 0) {
    Write-Host ''
    foreach ($item in $failures) { Write-Host "  ERR  $item" }
    Write-Host ''
    Write-Host $sep
    Write-Host " Summary: $($failures.Count) pair(s) out of parity"
    Write-Host $sep
    Write-Host ''
    exit 1
}

Write-Host ''
Write-Host '  OK   All pairs carry identical shared prose.'
Write-Host $sep
Write-Host ''
