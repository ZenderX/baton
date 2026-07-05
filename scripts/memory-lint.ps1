<#
.SYNOPSIS
    Lints the .claude/agent-memory/ Obsidian vault for naming, frontmatter, link, and index integrity.
.DESCRIPTION
    Report mode (default): surfaces all issues without modifying files. Exits non-zero on integrity errors.

    Fix mode (-Fix): applies safe, deterministic auto-repairs:
      - Renames <type>_<slug>.md -> <slug>.md (anchored to known type-prefix list only)
      - Rewrites the folder's MEMORY.md path links to match renamed files
      - Adds metadata.updated if absent from a note's metadata block
      - Normalizes tags from inline [a, b] form to YAML list form
      - Regenerates .obsidian/graph.json colorGroups: one deterministic color per
        topic/* tag in use (ordered first, matching Obsidian's first-match-wins
        semantics), followed by the static type/* fallback groups

    All checks are idempotent: re-running -Fix on a clean vault produces zero changes.
.PARAMETER Fix
    Apply safe auto-repairs. Idempotent.
.PARAMETER StaleDays
    Days since metadata.updated before a decaying note is flagged stale. Default: 90.
#>
param(
    [switch]$Fix,
    [int]$StaleDays = 90
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VaultRoot   = Join-Path $ProjectRoot '.claude' 'agent-memory'

# Known runtime-generated type prefixes. Anchored so slugs containing _ are not mangled.
[string[]]$KnownPrefixes = @(
    'project', 'user', 'feedback', 'reference',
    'planning', 'implementation', 'research', 'review', 'tombstone'
)
$TypePrefixPattern = '^(' + ($KnownPrefixes -join '|') + ')_(.+)$'

# Metadata types that are subject to staleness checks.
[string[]]$DecayingTypes = @('research')

# Static type-based graph.json colorGroups (fallback for notes without a topic/* tag).
# Order matches the vault's existing graph.json layout. Obsidian colorGroups are
# first-match-wins, so these must always be appended AFTER dynamic topic groups
# (Phase E), never before.
$StaticTypeColorGroups = @(
    [PSCustomObject]@{ query = 'tag:#type/user';           color = [PSCustomObject]@{ a = 1; rgb = 15057019 } }
    [PSCustomObject]@{ query = 'tag:#type/feedback';       color = [PSCustomObject]@{ a = 1; rgb = 14707829 } }
    [PSCustomObject]@{ query = 'tag:#type/project';        color = [PSCustomObject]@{ a = 1; rgb = 6402031 } }
    [PSCustomObject]@{ query = 'tag:#type/reference';      color = [PSCustomObject]@{ a = 1; rgb = 5682882 } }
    [PSCustomObject]@{ query = 'tag:#type/planning';       color = [PSCustomObject]@{ a = 1; rgb = 13007069 } }
    [PSCustomObject]@{ query = 'tag:#type/implementation'; color = [PSCustomObject]@{ a = 1; rgb = 10011513 } }
    [PSCustomObject]@{ query = 'tag:#type/research';       color = [PSCustomObject]@{ a = 1; rgb = 13736550 } }
    [PSCustomObject]@{ query = 'tag:#type/review';         color = [PSCustomObject]@{ a = 1; rgb = 12472390 } }
    [PSCustomObject]@{ query = 'tag:#type/tombstone';      color = [PSCustomObject]@{ a = 1; rgb = 6054768 } }
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Get-FrontmatterBlock([string]$content) {
    <#
    .SYNOPSIS Returns the raw YAML between the opening --- delimiters, or empty string.
    #>
    $m = [regex]::Match($content,
        '^---\r?\n([\s\S]*?)\r?\n---',
        [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
}

function Get-BodyText([string]$content) {
    <#
    .SYNOPSIS Returns the body text after the closing --- delimiter, or the full content if no frontmatter.
    #>
    $m = [regex]::Match($content,
        '^---\r?\n[\s\S]*?\r?\n---\r?\n?',
        [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if ($m.Success) { return $content.Substring($m.Index + $m.Length) }
    return $content
}

function Get-TagsFromYaml([string]$yaml) {
    <#
    .SYNOPSIS Parses tags from YAML; handles both inline [a, b] and list form.
    .OUTPUTS [string[]] tag strings; empty array if none found.
    #>
    # Inline form: tags: [a, b, c]
    $m = [regex]::Match($yaml, '(?m)^tags:\s*\[([^\]]+)\]')
    if ($m.Success) {
        return @($m.Groups[1].Value -split '\s*,\s*' |
            ForEach-Object { $_.Trim().Trim('"').Trim("'") } |
            Where-Object { $_ -ne '' })
    }
    # List form: tags:\n  - a\n  - b
    $m = [regex]::Match($yaml,
        '(?m)^tags:\s*\r?\n((?:[ \t]+-[ \t]+[^\r\n]+(?:\r?\n|$))+)')
    if ($m.Success) {
        return @($m.Groups[1].Value -split '\r?\n' |
            ForEach-Object { ($_ -replace '^\s*-\s*', '').Trim().Trim('"').Trim("'") } |
            Where-Object { $_ -ne '' })
    }
    return @()
}

function Get-NestedYamlValue([string]$yaml, [string]$parent, [string]$child) {
    <#
    .SYNOPSIS Returns the scalar value of a nested YAML key (e.g. metadata > updated), or $null.
    #>
    $parentEsc = [regex]::Escape($parent)
    $pm = [regex]::Match($yaml,
        "(?m)^$parentEsc`:\s*\r?\n((?:[ \t]+[^\r\n]*(?:\r?\n|$))*)")
    if (-not $pm.Success) { return $null }
    $childEsc = [regex]::Escape($child)
    $cm = [regex]::Match($pm.Groups[1].Value, "(?m)^\s+$childEsc`:\s*([^\r\n]+)")
    if ($cm.Success) { return $cm.Groups[1].Value.Trim() }
    return $null
}

function Get-Wikilinks([string]$body) {
    <#
    .SYNOPSIS Extracts [[wikilink]] targets from body text.
    Strips fenced code blocks and inline code before extraction to avoid false positives
    from illustrative examples.
    .OUTPUTS [string[]] unique link targets (original casing).
    #>
    # Strip fenced code blocks first (``` ... ```)
    $text = [regex]::Replace($body, '```[\s\S]*?```',
        '', [System.Text.RegularExpressions.RegexOptions]::Singleline)
    # Strip inline code (`...`)
    $text = [regex]::Replace($text, '`[^`\r\n]+`', '')
    # Extract [[target]] or [[target|display]]
    $ms = [regex]::Matches($text, '\[\[([^\]|#\r\n]+)(?:\|[^\]]*)?\]\]')
    if ($ms.Count -eq 0) { return @() }
    return @($ms | ForEach-Object { $_.Groups[1].Value.Trim() } | Select-Object -Unique)
}

function Get-MemoryIndexLinks([string]$content) {
    <#
    .SYNOPSIS Extracts filename.md targets from [Title](filename.md) markdown links in MEMORY.md.
    .OUTPUTS [string[]] unique filename strings.
    #>
    $ms = [regex]::Matches($content, '\[[^\]]+\]\(([^)]+\.md)\)')
    if ($ms.Count -eq 0) { return @() }
    return @($ms | ForEach-Object { $_.Groups[1].Value.Trim() } | Select-Object -Unique)
}

function ConvertTo-RgbFromHsl([double]$Hue, [double]$Saturation, [double]$Lightness) {
    <#
    .SYNOPSIS Converts HSL (hue 0-359 degrees; saturation/lightness 0-1) to RGB.
    .OUTPUTS Hashtable @{ R = <0-255>; G = <0-255>; B = <0-255> }
    #>
    $c      = (1 - [Math]::Abs(2 * $Lightness - 1)) * $Saturation
    $hPrime = $Hue / 60.0
    $x      = $c * (1 - [Math]::Abs(($hPrime % 2) - 1))
    $m      = $Lightness - ($c / 2)

    switch ([int][Math]::Floor($hPrime)) {
        0       { $r1, $g1, $b1 = $c, $x, 0 }
        1       { $r1, $g1, $b1 = $x, $c, 0 }
        2       { $r1, $g1, $b1 = 0, $c, $x }
        3       { $r1, $g1, $b1 = 0, $x, $c }
        4       { $r1, $g1, $b1 = $x, 0, $c }
        default { $r1, $g1, $b1 = $c, 0, $x }
    }

    return @{
        R = [int][Math]::Round(($r1 + $m) * 255)
        G = [int][Math]::Round(($g1 + $m) * 255)
        B = [int][Math]::Round(($b1 + $m) * 255)
    }
}

function Get-DeterministicTopicColor([string]$TopicName) {
    <#
    .SYNOPSIS Derives a stable graph.json color for a topic name: MD5(name) -> hue -> HSL -> packed RGB int.
    MD5 is used (not .NET string GetHashCode(), which is randomized per process) so the same
    topic name always yields the same color across runs and machines.
    .OUTPUTS [PSCustomObject] shaped like graph.json's color object: { a = 1; rgb = <int> }
    #>
    $md5 = [System.Security.Cryptography.MD5]::Create()
    try {
        $hashBytes = $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($TopicName))
    } finally {
        $md5.Dispose()
    }
    # First two hash bytes -> hue in [0, 359]. ~65% saturation / 55% lightness keeps colors
    # vivid but readable against the vault's dark graph background.
    $hue    = ([int]$hashBytes[0] * 256 + [int]$hashBytes[1]) % 360
    $rgb    = ConvertTo-RgbFromHsl -Hue $hue -Saturation 0.65 -Lightness 0.55
    $packed = ($rgb.R * 65536) + ($rgb.G * 256) + $rgb.B
    return [PSCustomObject]@{ a = 1; rgb = $packed }
}

function Test-ColorGroupsEqual($Current, $Expected) {
    <#
    .SYNOPSIS Structural (not string) comparison of two colorGroups arrays: same length,
    same query + color.a + color.rgb per entry, in the same order.
    #>
    $c = @($Current)
    $e = @($Expected)
    if ($c.Count -ne $e.Count) { return $false }
    for ($i = 0; $i -lt $e.Count; $i++) {
        if ($null -eq $c[$i]) { return $false }
        if ($c[$i].query -ne $e[$i].query) { return $false }
        if ($c[$i].color.a -ne $e[$i].color.a) { return $false }
        if ($c[$i].color.rgb -ne $e[$i].color.rgb) { return $false }
    }
    return $true
}

function Build-BasenameMap([System.IO.FileInfo[]]$files) {
    <#
    .SYNOPSIS Builds a hashtable of lowercased basename -> list of full paths (vault-wide).
    Used for link resolution and duplicate detection.
    MEMORY.md files are excluded: they are per-folder indexes accessed by path, not wikilink targets.
    #>
    $map = @{}
    foreach ($f in $files) {
        if ($f.Name -eq 'MEMORY.md') { continue }
        $bn = $f.BaseName.ToLower()
        if (-not $map.ContainsKey($bn)) {
            $map[$bn] = [System.Collections.Generic.List[string]]::new()
        }
        $map[$bn].Add($f.FullName)
    }
    return $map
}

# ---------------------------------------------------------------------------
# Scan vault
# ---------------------------------------------------------------------------

if (-not (Test-Path $VaultRoot)) {
    Write-Error "Vault root not found: $VaultRoot"
    exit 1
}

$allMdFiles   = @(Get-ChildItem -Path $VaultRoot -Recurse -Filter '*.md' -File)
$agentFolders = @(Get-ChildItem -Path $VaultRoot -Directory)

# Memory notes: inside agent sub-folders, not named MEMORY.md.
# These are the notes subject to per-note compliance checks.
$memoryNotes = @($allMdFiles | Where-Object {
    $_.DirectoryName -ne $VaultRoot -and $_.Name -ne 'MEMORY.md'
})

$basenameMap = Build-BasenameMap $allMdFiles

# ---------------------------------------------------------------------------
# Result tracking
# ---------------------------------------------------------------------------
$fixes         = [System.Collections.Generic.List[string]]::new()
$integrityErrs = [System.Collections.Generic.List[string]]::new()
$warnings      = [System.Collections.Generic.List[string]]::new()

# Dynamic topic/* usage: topic name -> list of notes (rel paths) using it.
# Topics are emergent (no canonical list) — this only tracks fragmentation, not validity.
$topicNotes = @{}

# ---------------------------------------------------------------------------
# Phase A: Rename type_slug.md -> slug.md (-Fix only; report-only otherwise)
# ---------------------------------------------------------------------------
foreach ($note in ($memoryNotes | Sort-Object FullName)) {
    if ($note.BaseName -notmatch $TypePrefixPattern) { continue }

    $newBase = $Matches[2]
    $newName = "$newBase.md"
    $oldName = $note.Name

    if ($Fix) {
        $newPath = Join-Path $note.DirectoryName $newName
        if (Test-Path $newPath) {
            $warnings.Add("RENAME-CONFLICT: '$oldName' -> '$newName' target already exists; resolve manually")
            continue
        }
        Rename-Item -Path $note.FullName -NewName $newName -ErrorAction Stop
        # Patch MEMORY.md in the same folder so index links remain valid.
        $memFile = Join-Path $note.DirectoryName 'MEMORY.md'
        if (Test-Path $memFile) {
            $mc = Get-Content $memFile -Raw -Encoding utf8
            if ($mc -match [regex]::Escape("($oldName)")) {
                $mc = $mc.Replace("($oldName)", "($newName)")
                Set-Content -Path $memFile -Value $mc -Encoding utf8NoBOM -NoNewline
            }
        }
        $fixes.Add("RENAMED $oldName -> $newName")
    } else {
        $warnings.Add("TYPE-PREFIX: '$oldName' should be '$newName' (run -Fix to rename)")
    }
}

# Re-scan after potential renames so all subsequent checks see accurate filenames.
if ($Fix) {
    $allMdFiles  = @(Get-ChildItem -Path $VaultRoot -Recurse -Filter '*.md' -File)
    $memoryNotes = @($allMdFiles | Where-Object {
        $_.DirectoryName -ne $VaultRoot -and $_.Name -ne 'MEMORY.md'
    })
    $basenameMap = Build-BasenameMap $allMdFiles
}

# ---------------------------------------------------------------------------
# Phase B: Duplicate basename detection (vault-wide integrity)
# ---------------------------------------------------------------------------
foreach ($entry in $basenameMap.GetEnumerator()) {
    if ($entry.Value.Count -gt 1) {
        $paths = $entry.Value -join ', '
        $integrityErrs.Add("DUPLICATE-BASENAME '[$($entry.Key)]' is ambiguous: $paths")
    }
}

# ---------------------------------------------------------------------------
# Phase C: Build wikilink graph (all files) and compliance checks (memory notes only)
# ---------------------------------------------------------------------------

# outbound wikilinks: note-basename (lowered) -> list of linked basenames (lowered)
# Only tracked for memory notes; used only for orphan check.
$outbound = @{}
# inbound wikilinks: target-basename (lowered) -> list of source basenames (lowered)
# Tracked for ALL targets; populated by any source file (including root files).
$inbound  = @{}

# Pre-initialize entries for all current memory notes so orphan check sees zero-counts.
foreach ($note in $memoryNotes) {
    $bn = $note.BaseName.ToLower()
    if (-not $outbound.ContainsKey($bn)) { $outbound[$bn] = [System.Collections.Generic.List[string]]::new() }
    if (-not $inbound.ContainsKey($bn))  { $inbound[$bn]  = [System.Collections.Generic.List[string]]::new() }
}

$today    = [datetime]::Today
$todayStr = $today.ToString('yyyy-MM-dd')

foreach ($f in $allMdFiles) {
    $content = Get-Content $f.FullName -Raw -Encoding utf8
    $body    = Get-BodyText $content
    $links   = Get-Wikilinks $body
    $srcBn   = $f.BaseName.ToLower()
    $srcRel  = if ($f.DirectoryName -eq $VaultRoot) { $f.Name } else { "$($f.Directory.Name)/$($f.Name)" }

    foreach ($link in $links) {
        $tgtBn = $link.ToLower()

        # Record outbound for memory notes only (root files don't participate in orphan check).
        if ($outbound.ContainsKey($srcBn)) { $outbound[$srcBn].Add($tgtBn) }

        # Record inbound for any target (memory notes, root files, etc.).
        if (-not $inbound.ContainsKey($tgtBn)) {
            $inbound[$tgtBn] = [System.Collections.Generic.List[string]]::new()
        }
        $inbound[$tgtBn].Add($srcBn)

        # Broken link: target basename not found anywhere in the vault.
        if (-not $basenameMap.ContainsKey($tgtBn)) {
            $integrityErrs.Add("BROKEN-LINK: [[$link]] in $srcRel")
        }
    }

    # Skip compliance checks for root-level files (e.g. _conventions.md) and MEMORY.md indexes.
    if ($f.DirectoryName -eq $VaultRoot -or $f.Name -eq 'MEMORY.md') { continue }

    $yaml = Get-FrontmatterBlock $content
    $rel  = "$($f.Directory.Name)/$($f.Name)"

    # --- Required tags ---
    $tags        = Get-TagsFromYaml $yaml
    $hasTypeTag  = @($tags | Where-Object { $_ -match '^type/'  }).Count -gt 0
    $hasTopicTag = @($tags | Where-Object { $_ -match '^topic/' }).Count -gt 0
    $hasAgentTag = @($tags | Where-Object { $_ -match '^agent/' }).Count -gt 0
    if (-not $hasTypeTag)  { $warnings.Add("MISSING-TAG type/*: $rel") }
    if (-not $hasTopicTag) { $warnings.Add("MISSING-TAG topic/*: $rel") }
    if (-not $hasAgentTag) { $warnings.Add("MISSING-TAG agent/*: $rel") }

    # --- Track topic/* usage for the fragmentation check (below the main loop) ---
    foreach ($topicTag in ($tags | Where-Object { $_ -match '^topic/' })) {
        $topicName = $topicTag -replace '^topic/', ''
        if (-not $topicNotes.ContainsKey($topicName)) {
            $topicNotes[$topicName] = [System.Collections.Generic.List[string]]::new()
        }
        $topicNotes[$topicName].Add($rel)
    }

    # --- Normalize inline tags [a, b] to list form (-Fix) ---
    if ($Fix -and @($tags).Count -gt 0 -and $yaml -match '(?m)^tags:\s*\[([^\]]+)\]') {
        $listLines = $tags | ForEach-Object { "  - $_" }
        $listBlock = "tags:`n" + ($listLines -join "`n")
        $newYaml   = [regex]::Replace($yaml, '(?m)^tags:\s*\[[^\]]+\]', $listBlock)
        if ($newYaml -ne $yaml) {
            $content = $content.Replace($yaml, $newYaml)
            Set-Content -Path $f.FullName -Value $content -Encoding utf8NoBOM -NoNewline
            $fixes.Add("NORMALIZED-TAGS: $rel")
            $yaml    = $newYaml
            $content = Get-Content $f.FullName -Raw -Encoding utf8
        }
    }

    # --- metadata.updated: report missing; add if -Fix ---
    $metaUpdated = Get-NestedYamlValue $yaml 'metadata' 'updated'
    if (-not $metaUpdated) {
        if ($Fix) {
            # Re-read to pick up any tag normalization just written.
            $content = Get-Content $f.FullName -Raw -Encoding utf8
            $yaml    = Get-FrontmatterBlock $content
            # Insert updated: after the type: line in the metadata block.
            $typeRx  = '^([ \t]+type:\s+\S[^\r\n]*)'
            $newYaml = [regex]::Replace($yaml, $typeRx,
                '$0' + "`n  updated: $todayStr",
                [System.Text.RegularExpressions.RegexOptions]::Multiline)
            if ($newYaml -ne $yaml) {
                $content = $content.Replace($yaml, $newYaml)
                Set-Content -Path $f.FullName -Value $content -Encoding utf8NoBOM -NoNewline
                $fixes.Add("ADDED-UPDATED: $rel")
                $metaUpdated = $todayStr
                $yaml = $newYaml
            } else {
                $warnings.Add("CANNOT-AUTO-FIX: no 'type:' line found in metadata block of $rel — add metadata.updated manually")
            }
        } else {
            $warnings.Add("MISSING-UPDATED: $rel")
        }
    }

    # --- Staleness check: decaying types only ---
    $metaType   = Get-NestedYamlValue $yaml 'metadata' 'type'
    $isDecaying = ($metaType -in $DecayingTypes) -or ($tags -contains 'decaying')
    if ($isDecaying -and $metaUpdated) {
        try {
            $updDate = [datetime]::ParseExact($metaUpdated, 'yyyy-MM-dd', $null)
            $ageDays = ($today - $updDate).Days
            if ($ageDays -gt $StaleDays) {
                $warnings.Add("STALE ($ageDays days): $rel — verify or refresh (threshold: $StaleDays days)")
            }
        } catch {
            # Unparseable date — MISSING-UPDATED already covers this case.
        }
    }

    # --- Dirty check: optional metadata.dirty flag (non-blocking WARN; -Fix does not touch this) ---
    $metaDirty = Get-NestedYamlValue $yaml 'metadata' 'dirty'
    if ($metaDirty) {
        $metaDirtyReason = Get-NestedYamlValue $yaml 'metadata' 'dirty_reason'
        $reasonStr = if ($metaDirtyReason) { $metaDirtyReason } else { 'no reason recorded' }
        $warnings.Add("DIRTY (since $metaDirty): $rel — flagged by memory-subagent; re-evaluate and re-link (reason: $reasonStr)")
    }
}

# --- Orphan check: memory notes with no inbound AND no outbound wikilinks ---
foreach ($note in $memoryNotes) {
    $bn  = $note.BaseName.ToLower()
    $rel = "$($note.Directory.Name)/$($note.Name)"
    $hasOut = $outbound.ContainsKey($bn) -and $outbound[$bn].Count -gt 0
    $hasIn  = $inbound.ContainsKey($bn)  -and $inbound[$bn].Count  -gt 0
    if (-not $hasOut -and -not $hasIn) {
        $warnings.Add("ORPHAN (no [[links]] in or out): $rel")
    }
}

# --- Topic fragmentation check: a topic used by exactly one note, only meaningful ---
# --- once the vault has more than one distinct topic to potentially consolidate into. ---
if ($topicNotes.Keys.Count -gt 1) {
    foreach ($entry in $topicNotes.GetEnumerator()) {
        if ($entry.Value.Count -eq 1) {
            $warnings.Add("TOPIC-SINGLETON: topic/$($entry.Key) used by only one note ($($entry.Value[0])) — consider reusing an existing topic or cross-linking")
        }
    }
}

# ---------------------------------------------------------------------------
# Phase D: MEMORY.md index integrity
# ---------------------------------------------------------------------------
foreach ($folder in $agentFolders) {
    $memFile = Join-Path $folder.FullName 'MEMORY.md'
    $rel     = $folder.Name

    if (-not (Test-Path $memFile)) {
        $warnings.Add("MISSING-INDEX: $rel/MEMORY.md does not exist")
        continue
    }

    $memContent   = Get-Content $memFile -Raw -Encoding utf8
    $indexedFiles = Get-MemoryIndexLinks $memContent
    $folderNotes  = @(Get-ChildItem -Path $folder.FullName -Filter '*.md' -File |
                      Where-Object { $_.Name -ne 'MEMORY.md' })

    # Every path in the index must resolve to a real file in this folder.
    foreach ($linked in $indexedFiles) {
        $expectedPath = Join-Path $folder.FullName $linked
        if (-not (Test-Path $expectedPath)) {
            $integrityErrs.Add("INDEX-DEAD-LINK: $rel/MEMORY.md -> '$linked' (file not found)")
        }
    }

    # Every note file in the folder must appear in the index.
    foreach ($note in $folderNotes) {
        if ($note.Name -notin $indexedFiles) {
            $integrityErrs.Add("FILE-NOT-INDEXED: $rel/$($note.Name) missing from MEMORY.md")
        }
    }
}

# ---------------------------------------------------------------------------
# Phase E: Graph colorGroups sync (topic-aware graph colorization)
# ---------------------------------------------------------------------------
# Obsidian colorGroups are first-match-wins, so dynamic topic/* groups (derived from
# $topicNotes, built in Phase C) must precede the static type/* fallback groups.
$graphJsonPath = Join-Path $VaultRoot '.obsidian' 'graph.json'

if (-not (Test-Path $graphJsonPath)) {
    $warnings.Add("GRAPH-MISSING: .obsidian/graph.json not found; skipping colorGroups sync")
} else {
    $graphObj = $null
    try {
        $graphObj = (Get-Content -Path $graphJsonPath -Raw -Encoding utf8) | ConvertFrom-Json
    } catch {
        $warnings.Add("GRAPH-INVALID: .obsidian/graph.json is not valid JSON; skipping colorGroups sync")
    }

    if ($graphObj) {
        # Ordinal sort so topic ordering is identical across locales/machines.
        $topicNames = [string[]]$topicNotes.Keys
        [Array]::Sort($topicNames, [StringComparer]::Ordinal)

        $expectedColorGroups = [System.Collections.Generic.List[object]]::new()
        foreach ($topicName in $topicNames) {
            $expectedColorGroups.Add([PSCustomObject]@{
                query = "tag:#topic/$topicName"
                color = Get-DeterministicTopicColor $topicName
            })
        }
        foreach ($staticGroup in $StaticTypeColorGroups) { $expectedColorGroups.Add($staticGroup) }

        # Guard property access: StrictMode throws PropertyNotFoundException if valid JSON
        # simply lacks a colorGroups key. Treat "key absent" as empty (flows into GRAPH-DESYNC/-Fix).
        $hasColorGroupsProp = $graphObj.PSObject.Properties.Name -contains 'colorGroups'
        $currentColorGroups = if ($hasColorGroupsProp) { @($graphObj.colorGroups) } else { @() }

        if (-not (Test-ColorGroupsEqual $currentColorGroups $expectedColorGroups)) {
            if ($Fix) {
                # Direct assignment throws under StrictMode when the key is absent, but when
                # it IS present, Add-Member -Force would relocate it to the end of the property
                # list (needless key-order churn). Only fall back to Add-Member when absent.
                if ($hasColorGroupsProp) {
                    $graphObj.colorGroups = $expectedColorGroups.ToArray()
                } else {
                    $graphObj | Add-Member -MemberType NoteProperty -Name 'colorGroups' -Value $expectedColorGroups.ToArray() -Force
                }
                # Trailing newline preserves the hand-authored-file convention; comparison
                # above is structural, so this does not affect idempotency.
                $newJson = ($graphObj | ConvertTo-Json -Depth 10) + "`n"
                Set-Content -Path $graphJsonPath -Value $newJson -Encoding utf8NoBOM -NoNewline
                $fixes.Add("GRAPH-SYNC: regenerated colorGroups ($($topicNames.Count) topic group(s) + $($StaticTypeColorGroups.Count) type group(s))")
            } else {
                $warnings.Add("GRAPH-DESYNC: graph.json colorGroups out of sync with vault topics (run -Fix to regenerate)")
            }
        }
    }
}

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
$sep = '=' * 64
Write-Host ''
Write-Host $sep
Write-Host ' Memory Vault Lint Report'
Write-Host " Vault : $VaultRoot"
Write-Host " Date  : $todayStr"
Write-Host " Mode  : $(if ($Fix) { 'Fix' } else { 'Report' })"
Write-Host $sep

if ($fixes.Count -gt 0) {
    Write-Host ''
    Write-Host '--- Fixes Applied ---'
    foreach ($item in $fixes) { Write-Host "  FIX  $item" }
}

if ($integrityErrs.Count -gt 0) {
    Write-Host ''
    Write-Host '--- Integrity Errors (gate-blocking) ---'
    foreach ($item in $integrityErrs) { Write-Host "  ERR  $item" }
}

if ($warnings.Count -gt 0) {
    Write-Host ''
    Write-Host '--- Warnings (judgment or manual fix needed) ---'
    foreach ($item in $warnings) { Write-Host " WARN  $item" }
}

Write-Host ''
if ($integrityErrs.Count -eq 0 -and $warnings.Count -eq 0 -and $fixes.Count -eq 0) {
    Write-Host '  OK   Vault is clean.'
} elseif ($Fix -and $integrityErrs.Count -eq 0 -and $warnings.Count -eq 0) {
    Write-Host '  OK   All fixes applied; vault is clean.'
}
Write-Host $sep
Write-Host " Summary: $($integrityErrs.Count) error(s)  $($warnings.Count) warning(s)  $($fixes.Count) fix(es)"
Write-Host $sep
Write-Host ''

if ($integrityErrs.Count -gt 0) { exit 1 }
