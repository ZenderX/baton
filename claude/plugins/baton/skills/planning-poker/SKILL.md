---
name: planning-poker
description: Fibonacci story-point estimation of plan phases in planning-poker style - size drivers that include test and verification effort, anchors for 1, 3, 8 and 13, the split-above-8 rule, a calibration against long developer runs, and the Points line a phase records. Use when estimating, splitting or re-estimating the phases of a plan.
---

# Planning Poker

Size every phase of a plan in story points before the plan is final, so each phase fits one short developer run. One estimator plays the whole table: vote as each team voice would, compare, and settle as the team would.

## Scale

Fibonacci only: **1, 2, 3, 5, 8, 13, 21**. Points measure the whole run, not the code alone: reading, writing, test writing, every gate the phase runs and how long it takes, measurement runs, and the fix loop until the acceptance criteria pass.

- **8 is the ceiling.** A phase above 8 is split before the plan is final; a 13 or 21 is never written into a plan.
- Between two values, take the higher. Optimism is what makes a run long.

## Size drivers

Score a phase from its **Goal**, **Surface**, **Context**, **Unknowns** and **Acceptance criteria**. Each driver below pushes the estimate up:

| Driver | Pushes up when |
|---|---|
| Files touched | more than one or two files change |
| Subsystems | the change crosses a module, crate, package or layer boundary |
| New vs edited | a new module, type or file format is created rather than an existing one edited |
| Pattern to mirror | no neighbouring code shows the shape to copy |
| Unknowns | the phase lists open questions, or Context leaves a behaviour unlocated |
| Unmapped dependency code | the developer would have to read library sources nobody mapped (crates in `~/.cargo/registry`, `node_modules` internals) instead of documented APIs |
| Test writing | new tests or fixtures must be written, not existing ones re-run |
| Gate cost | a gate is slow (release build, full suite, minutes per run) or runs several times |
| Measurement | the criteria need benchmarks, pixel or output comparisons, or repeated sampling |

## Anchors

**1** — one edited file in one subsystem, an existing pattern a few lines away to mirror, no unknowns; the gate is a type-check or one existing test, nothing new to write.

**3** — two to four edited files in one subsystem, or one small new function beside existing ones; context fully mapped; one test added or changed; gates are a debug build plus one test target, each well under a minute.

**8** — one new module plus its wiring, or five to eight files across two subsystems; at most one open unknown or one dependency API to look up in its docs; several new tests; a full suite or a build of minutes run more than once, or one measurement pass. The most one developer run should carry.

**13** — a whole feature across three or more subsystems: new modules plus edits to existing ones, dependency code nobody mapped, several open unknowns, new test suites, and slow gates or measurement runs repeated through the fix loop. Never planned; split.

**21** — several features, or a feature whose design is still open. Split, and when no seam is visible, send the open design back to analysis rather than guess.

2 and 5 sit between their neighbours.

## Voting

1. **Deal.** List the phase's drivers from the table, each with its concrete count (files, subsystems, tests, gate minutes).
2. **Vote blind.** Score the phase three times, each from one voice only:
   - **developer** — code to read and write, new vs edited, patterns to mirror;
   - **reviewer** — tests to write, gates to run, their cost and repetitions, measurement;
   - **analyst** — unknowns, unmapped code, how much of Context is located versus assumed.
3. **Reveal.** If the three votes sit on adjacent values or agree, take the highest.
4. **Discuss.** If they span more than one step (a 2 and an 8), the high voice names the driver the others missed and the low voice names what the high one over-counted; re-vote once, then take the highest of the new votes.
5. **Decide.** 8 or below: record it. Above 8: split.

## Splitting

- Cut along a seam where each part has its own **Acceptance criteria** and passes its own gates: by subsystem, by layer (data model, then behaviour, then presentation), or new module first and its integration second.
- Never split code from its tests; each part writes and runs the tests for what it builds.
- Name what each part hands the next under its Context and add the dependency rows to the plan's phase index.
- Re-estimate every part with a fresh vote; repeat until every part scores 8 or below.
- A part that stays above 8 with no seam left means the goal is under-specified: list the gap under **Unknowns** instead of forcing a split.

## Recording

Write the estimate on its own line directly after the phase's **Acceptance criteria** list:

```markdown
**Points:** <1|2|3|5|8> — <one clause naming the size driver>
```

Example: `**Points:** 5 — two subsystems edited and a new integration test on a three-minute debug build`.

The clause names the driver that set the value, so a reviewer can challenge it. Re-estimate a phase whenever a **Revision** changes its Surface, Context or Acceptance criteria.

## Calibration

A real feature job on a game engine shows what an unsplit 13 costs. Each of these phases built a whole feature across several subsystems in one developer run, and each scores **13 or more**:

| Phase | Turns | Minutes |
|---|---|---|
| A font-synthesis feature | 231 | 52 |
| An SVG paint feature | 232 | 47 |
| A vertical-text feature | 172 | 48 |
| A shapes feature | 155 | 37 |

Their contexts reached about 350k tokens, model latency per turn rose from about 3.2 s under 50k tokens to about 5.5 s above 150k, and much of the growth was third-party dependency sources read from the package cache plus build and test logs. A plan that scores any of them 8 or below is mis-estimating: recount the subsystems, the unmapped dependency code and the gate repetitions, and split.
