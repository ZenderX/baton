<#
.SYNOPSIS
    Lints the .claude/agent-memory/ Obsidian vault for naming, frontmatter, link, and index integrity.
.DESCRIPTION
    Report mode (default): surfaces all issues without modifying files. Exits non-zero on integrity errors.

    Fix mode (-Fix): applies safe, deterministic auto-repairs:
      - Renames <type>_<slug>.md -> <slug>.md (anchored to known type-prefix list only)
      - Rewrites the folder's MEMORY.md path links to match renamed files
      - Relocates a dirty banner line misplaced inside the frontmatter block back to the
        body (see DIRTY-BANNER-IN-FRONTMATTER below) — the frontmatter/body split is
        purely mechanical, so this repair is fully deterministic
      - Adds metadata.updated if absent from a note's metadata block
      - Normalizes tags from inline [a, b] form to YAML list form
      - Regenerates .obsidian/graph.json colorGroups: one deterministic color per
        topic/* tag in use (ordered first, matching Obsidian's first-match-wins
        semantics), followed by the static type/* fallback groups

    All checks are idempotent: re-running -Fix on a clean vault produces zero changes.

    Report mode also flags (all deterministic, no model judgment):
      - NO-INBOUND: a note has outbound [[links]] but nothing links back to it
      - TAG-SPRAWL: an ad hoc tag outside the type/*|agent/*|topic/* scaffold used by
        exactly one note (topic/* is excluded — TOPIC-SINGLETON below owns that namespace)
      - EXPIRED: metadata.expires is in the past
      - STALE-ORPHAN: metadata.updated older than -OrphanStaleDays AND zero inbound links
        (the two-factor combination; age alone is not flagged this way)
      - NAME-MISMATCH: name: frontmatter disagrees with the filename
      - TYPE-MISMATCH: metadata.type disagrees with the type/* tag
      - BROKEN-LINK-NAME: a [[wikilink]] target matches no note's declared name: field
        (gate-blocking, like BROKEN-LINK)
      - DIRTY-BANNER-IN-FRONTMATTER: the dirty banner line (inserted by the memory subagent
        §3) landed before the frontmatter's closing --- instead of after it, corrupting
        the YAML block (gate-blocking, like BROKEN-LINK; -Fix relocates it deterministically,
        preserving the file's original CRLF/LF convention). Scope boundary: detection relies
        on Get-FrontmatterBlock finding a closing ---; a note missing the closing delimiter
        entirely returns an empty block and this check does not fire — no other check in this
        script catches a missing closing delimiter either, so this is a known gap, not a bug.
        -Fix also warns (MULTIPLE-DIRTY-BANNERS) if more than one stranded banner is found in
        a single frontmatter block; only the last is kept, and the collapse is reported rather
        than silent.
      - DIRTY-MISSING-REASON: metadata.dirty is set but metadata.dirty_reason is absent or
        empty (warning; never auto-fixed — inventing a reason is a judgment call, not a
        mechanical repair)
      - STRAY-LOCATION: any directory found anywhere under the project root (pruning .git,
        releases, node_modules) that has a MEMORY.md file as a direct child, and is neither
        the vault root itself nor a direct child of the vault root. Detection is purely by
        MEMORY.md presence — no plugin/agent name roster involved, so it's rename-proof.
        Found via a manual, symlink-safe directory walk (not Get-ChildItem -Recurse), so a
        cyclic symlink/junction cannot cause an infinite walk. Read-only: detected and
        reported only, never moved or deleted — the memory subagent step 0 owns the remedy
        (canonical note takes precedence, then prune the stray).
.PARAMETER Fix
    Apply safe auto-repairs. Idempotent.
.PARAMETER StaleDays
    Days since metadata.updated before a decaying note is flagged stale. Default: 90.
.PARAMETER OrphanStaleDays
    Days since metadata.updated before a note with zero inbound links is flagged
    STALE-ORPHAN (the two-factor dead-weight signal). Default: 180.
.PARAMETER VaultRoot
    Override the vault path (default: <repo>/.claude/agent-memory). Lets a scratch
    fixture be linted without touching the real vault. When explicitly passed, the
    STRAY-LOCATION walk root becomes this path's parent instead of the real project
    root, so a scratch-fixture lint run scans only the fixture, not the real repo.
#>
param(
    [switch]$Fix,
    [int]$StaleDays = 90,
    [int]$OrphanStaleDays = 180,
    [string]$VaultRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Captured before the default-assignment below overwrites $VaultRoot, so the
# STRAY-LOCATION walk-root logic (Phase A0) can tell "caller passed -VaultRoot"
# apart from "using the default" even though both end up with a non-empty value.
$VaultRootWasSpecified = $PSBoundParameters.ContainsKey('VaultRoot')

$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not $VaultRoot) {
    $VaultRoot = Join-Path $ProjectRoot '.claude' 'agent-memory'
}

# Known runtime-generated type prefixes. Anchored so slugs containing _ are not mangled.
[string[]]$KnownPrefixes = @(
    'project', 'user', 'feedback', 'reference',
    'planning', 'implementation', 'research', 'review', 'tombstone'
)
$TypePrefixPattern = '^(' + ($KnownPrefixes -join '|') + ')_(.+)$'

# Metadata types that are subject to staleness checks.
[string[]]$DecayingTypes = @('research')

# Dirty banner line, as inserted by the memory subagent §3 / cleared by memory-write's
# "Clearing a Dirty Flag". Matched by both DIRTY-BANNER-IN-FRONTMATTER (detects it stranded
# inside the YAML block, which corrupts frontmatter) and the -Fix relocation repair.
# Deliberately tolerant of the date and the free-text reason varying — only the fixed
# emoji/bold-DIRTY/since-date prefix is anchored, matching the byte-identical banner text
# specified across the memory subagent, memory-write, and memory-review. No line anchors here:
# the pattern is matched both against a single split line (Repair-DirtyBannerPlacement) and
# as a substring test against the whole frontmatter blob (the Phase A2 detection below).
$DirtyBannerLinePattern = '>\s*⚠️\s*\*\*DIRTY \(since \d{4}-\d{2}-\d{2}\):\*\*'

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
    Scope boundary: requires both an opening AND a closing ---. A note missing the closing
    delimiter entirely returns '' here, so DIRTY-BANNER-IN-FRONTMATTER (and every other check
    fed by this helper) silently does not fire on that file — a known gap, not a bug; see the
    DIRTY-BANNER-IN-FRONTMATTER entry in this script's .DESCRIPTION for the full rationale.
    #>
    $m = [regex]::Match($content,
        '^---\r?\n([\s\S]*?)\r?\n---',
        [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
}

function Get-DominantEol([string]$content) {
    <#
    .SYNOPSIS Detects whether $content's dominant line-ending convention is CRLF or LF, by
    counting CRLF pairs against standalone (non-CRLF) LFs. Used by Repair-DirtyBannerPlacement
    so its reconstructed frontmatter/banner region is rebuilt using the SAME convention as the
    rest of the file, instead of a hardcoded "`n" — a hardcoded choice would leave a CRLF-authored
    note with a mixed-EOL file (LF in the repaired region, CRLF in the untouched body), which is
    silently surprising in a git diff and outside this script's "safe, deterministic" bar.
    .OUTPUTS [string] "`r`n" or "`n". Defaults to "`n" when the content has no CRLF pairs at all
    (includes the no-line-breaks-whatsoever case).
    #>
    $crlfCount = ([regex]::Matches($content, "`r`n")).Count
    $lfCount   = ([regex]::Matches($content, "(?<!`r)`n")).Count
    if ($crlfCount -gt 0 -and $crlfCount -ge $lfCount) { return "`r`n" }
    return "`n"
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

function Get-ScalarYamlValue([string]$yaml, [string]$key) {
    <#
    .SYNOPSIS Returns a top-level (non-nested) scalar YAML value, e.g. `name: foo`, or $null.
    #>
    $keyEsc = [regex]::Escape($key)
    $m = [regex]::Match($yaml, "(?m)^$keyEsc`:\s*([^\r\n]+)")
    if ($m.Success) { return $m.Groups[1].Value.Trim().Trim('"').Trim("'") }
    return $null
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

function Repair-DirtyBannerPlacement([string]$content, [string]$yaml, [string]$bannerPattern) {
    <#
    .SYNOPSIS Given a note's raw content and a frontmatter block containing a dirty banner
    line stranded inside it, returns the repaired full file content: the banner line is
    removed from the YAML block (along with one immediately-preceding blank line, the stray
    gap the misplaced banner typically left behind) and re-inserted as the first line of the
    body, immediately after the closing ---, matching the depiction in the memory subagent §3.
    The reconstructed frontmatter/delimiter/banner region is rebuilt using $content's own
    dominant EOL convention (see Get-DominantEol) rather than a hardcoded LF, so a CRLF-authored
    note comes out fully CRLF instead of a mixed-EOL file — the untouched body already uses
    that same convention, so this keeps the whole file on exactly one.
    .OUTPUTS [PSCustomObject] { Content = <corrected full file content>;
    BannerCount = <int, number of stranded banner lines found> }. BannerCount lets the caller
    (Phase A2) warn when more than one banner was trapped in a single frontmatter block — only
    the last match is kept as the relocated banner and any earlier ones are discarded, so a
    count > 1 signals a silent-data-loss anomaly the caller should surface rather than repair.
    #>
    $eol        = Get-DominantEol $content
    $yamlLines  = $yaml -split '\r?\n'
    $cleanLines = [System.Collections.Generic.List[string]]::new()
    $bannerLine  = $null
    $bannerCount = 0
    foreach ($line in $yamlLines) {
        if ($line -match $bannerPattern) {
            $bannerCount++
            $bannerLine = $line.Trim()
            if ($cleanLines.Count -gt 0 -and $cleanLines[$cleanLines.Count - 1].Trim() -eq '') {
                $cleanLines.RemoveAt($cleanLines.Count - 1)
            }
            continue
        }
        $cleanLines.Add($line)
    }
    # Trim any trailing blank lines left in the frontmatter block after banner removal.
    while ($cleanLines.Count -gt 0 -and $cleanLines[$cleanLines.Count - 1].Trim() -eq '') {
        $cleanLines.RemoveAt($cleanLines.Count - 1)
    }
    $cleanYaml = ($cleanLines -join $eol)

    # Drop leading blank lines from the original body — the banner supplies its own
    # separator (a blank line after it), so we don't want a double gap.
    $bodyText = (Get-BodyText $content) -replace '^(\r?\n)+', ''

    $repaired = "---$eol$cleanYaml$eol---$eol$bannerLine$eol$eol$bodyText"
    return [PSCustomObject]@{ Content = $repaired; BannerCount = $bannerCount }
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

function Test-ReparsePoint {
    <#
    .SYNOPSIS $true if $Path is a symlink/junction; -Force stats the reparse point itself.
    Mirrors the identical helper in scripts/clean-global.ps1 — kept as a local copy rather
    than a shared module since these are single-file maintainer scripts by convention.
    #>
    param([string]$Path)
    $item = Get-Item -Force -ErrorAction SilentlyContinue -Path $Path
    return ($null -ne $item) -and [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
}

function Get-MemoryMdDirs([string]$Root) {
    <#
    .SYNOPSIS Manually walks $Root (explicit stack, NOT Get-ChildItem -Recurse) and returns
    every directory that has a MEMORY.md file as a direct child. This is the sole signal
    STRAY-LOCATION uses to identify an agent-memory folder — no plugin/agent name roster
    involved, so the check is rename-proof by construction.
    Symlink-safe: each directory is checked via Test-ReparsePoint BEFORE its children are
    enumerated/pushed, so a cyclic symlink/junction cannot cause an infinite walk. Prunes
    .git, releases, node_modules by exact directory name at any depth (never descended into).
    .OUTPUTS [System.IO.DirectoryInfo[]] directories containing a direct-child MEMORY.md,
    including $Root itself if it qualifies. Empty array if $Root does not exist.
    #>
    $PruneNames = @('.git', 'releases', 'node_modules')
    $hits  = [System.Collections.Generic.List[System.IO.DirectoryInfo]]::new()
    $stack = [System.Collections.Generic.Stack[System.IO.DirectoryInfo]]::new()

    $rootItem = Get-Item -LiteralPath $Root -Force -ErrorAction SilentlyContinue
    if ($null -eq $rootItem) { return @() }
    $stack.Push($rootItem)

    while ($stack.Count -gt 0) {
        $dir = $stack.Pop()

        # Symlink/junction guard: checked before descending (not before pushing) so the
        # same reparse-point definition Test-ReparsePoint applies is used consistently,
        # and so a reparse point passed in directly as $Root is also honored.
        if (Test-ReparsePoint -Path $dir.FullName) { continue }

        # Single listing serves both the MEMORY.md check and the descend step below.
        # -ceq (case-SENSITIVE) is deliberate: on a case-insensitive-but-case-preserving
        # filesystem (default macOS/Windows), Test-Path/Join-Path resolution against
        # 'MEMORY.md' would also match a same-named-but-different-case file such as an
        # agent's own lowercase 'memory.md' — a real collision observed against
        # plugins/*/agents/memory.md, not a hypothetical. Get-ChildItem's returned .Name
        # is the on-disk (case-preserved) name, so -ceq correctly rejects that collision.
        $entries = @(Get-ChildItem -LiteralPath $dir.FullName -Force -ErrorAction SilentlyContinue)
        if (@($entries | Where-Object { -not $_.PSIsContainer -and $_.Name -ceq 'MEMORY.md' }).Count -gt 0) {
            $hits.Add($dir)
        }

        foreach ($child in ($entries | Where-Object { $_.PSIsContainer })) {
            if ($PruneNames -contains $child.Name) { continue }
            $stack.Push($child)
        }
    }

    return @($hits)
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

function Build-NameSlugMap([System.IO.FileInfo[]]$files) {
    <#
    .SYNOPSIS Builds a hashtable of lowercased frontmatter `name:` value -> list of full paths.
    Distinct from Build-BasenameMap (which keys on the filename): this map is used by the
    BROKEN-LINK-NAME check to catch wikilinks that resolve against a filename but not
    against any note's *declared* name: field (the two should always agree per the
    memory-write schema; a mismatch is exactly what NAME-MISMATCH also flags).
    Memory notes only (excludes MEMORY.md and root-level files, which have no name: field).
    #>
    $map = @{}
    foreach ($f in $files) {
        if ($f.Name -eq 'MEMORY.md' -or $f.DirectoryName -eq $VaultRoot) { continue }
        $content = Get-Content $f.FullName -Raw -Encoding utf8
        $yaml    = Get-FrontmatterBlock $content
        $nameVal = Get-ScalarYamlValue $yaml 'name'
        if (-not $nameVal) { continue }
        $slug = $nameVal.ToLower()
        if (-not $map.ContainsKey($slug)) {
            $map[$slug] = [System.Collections.Generic.List[string]]::new()
        }
        $map[$slug].Add($f.FullName)
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
$nameSlugMap = Build-NameSlugMap $allMdFiles

# ---------------------------------------------------------------------------
# Result tracking
# ---------------------------------------------------------------------------
$fixes         = [System.Collections.Generic.List[string]]::new()
$integrityErrs = [System.Collections.Generic.List[string]]::new()
$warnings      = [System.Collections.Generic.List[string]]::new()

# Dynamic topic/* usage: topic name -> list of notes (rel paths) using it.
# Topics are emergent (no canonical list) — this only tracks fragmentation, not validity.
$topicNotes = @{}

# Ad hoc tags outside the type/*|agent/*|topic/* scaffold -> list of notes using them.
# Feeds the TAG-SPRAWL check. topic/* is deliberately excluded here: TOPIC-SINGLETON
# (below) already owns that namespace and fires on the identical condition, so including
# topic/* would just duplicate every TOPIC-SINGLETON warning under a second name.
$allTagNotes = @{}

# note-basename (lowered) -> parsed metadata.updated [datetime], for notes where it parsed.
# Populated in the main per-note loop; consumed after inbound/outbound are fully built by
# the STALE-ORPHAN check (which needs both age and inbound-link count together).
$noteUpdatedDate = @{}

# ---------------------------------------------------------------------------
# Phase A0: STRAY-LOCATION detection (gate-blocking, read-only)
# ---------------------------------------------------------------------------
# Detect-only: this check never moves, creates, or deletes anything — remedy ownership is
# the memory subagent step 0 (canonical note wins, then prune the stray), never this script.
#
# Walk root: the real project root for a normal run (the cwd-wide scan the user asked for),
# but $VaultRoot's own parent when -VaultRoot was explicitly overridden — preserving the
# existing scratch-fixture test-isolation convention (a fixture lint run scans only the
# fixture, never the real repo it happens to live under).
$StrayWalkRoot = if ($VaultRootWasSpecified) { Split-Path -Parent $VaultRoot } else { $ProjectRoot }

# Every directory anywhere under $StrayWalkRoot (pruning .git/releases/node_modules) that has
# a MEMORY.md file as a direct child. A directory qualifies as "canonical" purely by being
# $VaultRoot itself or a direct child of it — no plugin/agent name roster involved, so this
# is rename-proof by construction and requires no retro-compat name list.
$memoryMdDirs = @(Get-MemoryMdDirs -Root $StrayWalkRoot | Sort-Object FullName)
foreach ($dir in $memoryMdDirs) {
    if ($dir.FullName -eq $VaultRoot) { continue }  # never flag the vault root itself
    $parentDir = Split-Path -Parent $dir.FullName
    if ($parentDir -eq $VaultRoot) { continue }  # canonical folder, direct child of vault root
    $integrityErrs.Add("STRAY-LOCATION: $($dir.FullName) — notes outside canonical folders; the memory subagent must integrate them (canonical note takes precedence, then prune the stray)")
}

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
    $nameSlugMap = Build-NameSlugMap $allMdFiles
}

# ---------------------------------------------------------------------------
# Phase A2: DIRTY-BANNER-IN-FRONTMATTER detection/relocation (gate-blocking)
# ---------------------------------------------------------------------------
# The dirty banner (inserted by the memory subagent §3) must live in the BODY, as the first
# line after frontmatter's closing ---. If it instead landed inside the metadata: block,
# the YAML is corrupted (a blockquote line inside a mapping is not valid YAML). This runs
# as its own phase, before Phase C builds the wikilink graph, so that in -Fix mode the
# relocated content — not the pre-repair corrupted content — is what Phase C actually sees.
foreach ($note in ($memoryNotes | Sort-Object FullName)) {
    $content = Get-Content -LiteralPath $note.FullName -Raw -Encoding utf8
    $yaml    = Get-FrontmatterBlock $content
    if ($yaml -notmatch $DirtyBannerLinePattern) { continue }

    $rel = "$($note.Directory.Name)/$($note.Name)"
    if ($Fix) {
        $repairResult = Repair-DirtyBannerPlacement -content $content -yaml $yaml -bannerPattern $DirtyBannerLinePattern
        Set-Content -Path $note.FullName -Value $repairResult.Content -Encoding utf8NoBOM -NoNewline
        $fixes.Add("RELOCATED-DIRTY-BANNER: $rel")
        if ($repairResult.BannerCount -gt 1) {
            $warnings.Add("MULTIPLE-DIRTY-BANNERS: $rel — found $($repairResult.BannerCount) stranded dirty banner lines in one frontmatter block; only the last was kept, earlier one(s) were discarded (investigate manually)")
        }
    } else {
        $integrityErrs.Add("DIRTY-BANNER-IN-FRONTMATTER: $rel — dirty banner text found inside the frontmatter block, corrupting YAML (run -Fix to relocate it to the body)")
    }
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

        # Broken link (by declared name): target matches no note's frontmatter `name:`
        # value, even if a same-named file exists. Distinct from BROKEN-LINK above (which
        # is filename-based, matching how Obsidian actually resolves a wikilink) — this
        # check independently verifies the *declared identity* side of the graph, so a
        # NAME-MISMATCH note (filename and name: field disagree) shows up here too.
        if (-not $nameSlugMap.ContainsKey($tgtBn)) {
            $integrityErrs.Add("BROKEN-LINK-NAME: [[$link]] in $srcRel (no note declares this name:)")
        }
    }

    # Skip compliance checks for root-level files (e.g. _conventions.md) and MEMORY.md indexes.
    if ($f.DirectoryName -eq $VaultRoot -or $f.Name -eq 'MEMORY.md') { continue }

    $yaml = Get-FrontmatterBlock $content
    $rel  = "$($f.Directory.Name)/$($f.Name)"

    # --- name: frontmatter must match the filename (memory-write schema invariant) ---
    $nameField = Get-ScalarYamlValue $yaml 'name'
    if ($nameField -and $nameField.ToLower() -ne $f.BaseName.ToLower()) {
        $warnings.Add("NAME-MISMATCH: $rel declares name: '$nameField' but filename is '$($f.BaseName)'")
    }

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

    # --- Track ad hoc tags outside the type/*|agent/*|topic/* scaffold for the TAG-SPRAWL
    #     check (below the main loop). topic/* is excluded — TOPIC-SINGLETON above already
    #     covers that namespace exhaustively. ---
    foreach ($tag in ($tags | Where-Object { $_ -notmatch '^type/' -and $_ -notmatch '^agent/' -and $_ -notmatch '^topic/' })) {
        if (-not $allTagNotes.ContainsKey($tag)) {
            $allTagNotes[$tag] = [System.Collections.Generic.List[string]]::new()
        }
        $allTagNotes[$tag].Add($rel)
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

    # Record the parsed date for the STALE-ORPHAN check (run after inbound/outbound are
    # fully built, since it needs every note's final inbound-link count). Any note with a
    # parseable metadata.updated is eligible, not just decaying types.
    if ($metaUpdated) {
        try {
            $noteUpdatedDate[$srcBn] = [datetime]::ParseExact($metaUpdated, 'yyyy-MM-dd', $null)
        } catch {
            # Unparseable date — MISSING-UPDATED already covers this case.
        }
    }

    # --- metadata.expires: warn if past due (freshness schema; only meaningful when set) ---
    $metaExpires = Get-NestedYamlValue $yaml 'metadata' 'expires'
    if ($metaExpires) {
        try {
            $expDate = [datetime]::ParseExact($metaExpires, 'yyyy-MM-dd', $null)
            if ($expDate -lt $today) {
                $ageDays = ($today - $expDate).Days
                $warnings.Add("EXPIRED ($ageDays days ago): $rel — re-verify against current state, refresh, or prune")
            }
        } catch {
            $warnings.Add("BAD-EXPIRES: $rel — metadata.expires '$metaExpires' is not a parseable YYYY-MM-DD date")
        }
    }

    # --- Staleness check: decaying types only ---
    $metaType   = Get-NestedYamlValue $yaml 'metadata' 'type'
    $isDecaying = ($metaType -in $DecayingTypes) -or ($tags -contains 'decaying')

    # --- metadata.type must match the type/* tag suffix (memory-write schema invariant) ---
    $typeTag = ($tags | Where-Object { $_ -match '^type/' } | Select-Object -First 1)
    if ($metaType -and $typeTag) {
        $typeTagValue = $typeTag -replace '^type/', ''
        if ($metaType -ne $typeTagValue) {
            $warnings.Add("TYPE-MISMATCH: $rel — metadata.type '$metaType' disagrees with tag 'type/$typeTagValue'")
        }
    }

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
        # Strip surrounding quotes before the emptiness check — dirty_reason is typically
        # quoted (it contains a wikilink and punctuation), and Get-NestedYamlValue does not
        # strip quotes the way Get-ScalarYamlValue does.
        $reasonNormalized = if ($metaDirtyReason) { $metaDirtyReason.Trim().Trim('"').Trim("'") } else { $null }
        $reasonStr = if ($reasonNormalized) { $reasonNormalized } else { 'no reason recorded' }
        $warnings.Add("DIRTY (since $metaDirty): $rel — flagged by the memory subagent; re-evaluate and re-link (reason: $reasonStr)")
        if ([string]::IsNullOrWhiteSpace($reasonNormalized)) {
            # Never auto-fixed: inventing a reason is a judgment call, and a fabricated
            # reason is worse than an honest gap (see the memory subagent §3 / this script's
            # .DESCRIPTION for why -Fix deliberately does not touch this).
            $warnings.Add("DIRTY-MISSING-REASON: $rel — metadata.dirty is set but metadata.dirty_reason is absent or empty")
        }
    }
}

# --- Orphan check: memory notes with no inbound AND no outbound wikilinks ---
# --- NO-INBOUND check: has outbound links but nothing links back — a narrower, distinct ---
# --- signal from ORPHAN above (deliberately not re-fired when ORPHAN already covers the ---
# --- no-links-at-all case, to avoid double-reporting the same note under two flags). ---
# --- STALE-ORPHAN check: >OrphanStaleDays old AND zero inbound, regardless of outbound — ---
# --- the two-factor dead-weight signal; age alone is intentionally not sufficient. ---
foreach ($note in $memoryNotes) {
    $bn  = $note.BaseName.ToLower()
    $rel = "$($note.Directory.Name)/$($note.Name)"
    $hasOut = $outbound.ContainsKey($bn) -and $outbound[$bn].Count -gt 0
    $hasIn  = $inbound.ContainsKey($bn)  -and $inbound[$bn].Count  -gt 0

    if (-not $hasOut -and -not $hasIn) {
        $warnings.Add("ORPHAN (no [[links]] in or out): $rel")
    } elseif ($hasOut -and -not $hasIn) {
        $warnings.Add("NO-INBOUND: $rel — has outbound [[links]] but nothing links back to it")
    }

    if (-not $hasIn -and $noteUpdatedDate.ContainsKey($bn)) {
        $ageDays = ($today - $noteUpdatedDate[$bn]).Days
        if ($ageDays -gt $OrphanStaleDays) {
            $warnings.Add("STALE-ORPHAN ($ageDays days, no inbound): $rel — verify against current state or prune (threshold: $OrphanStaleDays days)")
        }
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

# --- Tag-sprawl check: an ad hoc tag outside the type/*|agent/*|topic/* scaffold used by ---
# --- exactly one note. Division of labor vs. TOPIC-SINGLETON above: that check owns the ---
# --- topic/* namespace exhaustively, so TAG-SPRAWL excludes topic/* to avoid re-firing the ---
# --- identical warning under a second name. TAG-SPRAWL's novel value is catching sprawl in ---
# --- tags OUTSIDE the established taxonomy entirely (e.g. a stray one-off 'status/draft'). ---
foreach ($entry in $allTagNotes.GetEnumerator()) {
    if ($entry.Value.Count -eq 1) {
        $warnings.Add("TAG-SPRAWL: '$($entry.Key)' used by only one note ($($entry.Value[0])) — consider reusing an existing tag")
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
