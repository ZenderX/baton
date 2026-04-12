---
description: "Blender editor integration via bevy_skein conventions and workflow"
applyTo: "**/*.rs"
---

# Blender Integration via bevy_skein

Scope: Conventions for Blender-to-Bevy workflow using `bevy_skein`. Pure Rust standards live in `rust.instructions.md`; Bevy patterns live in `bevy.instructions.md`. All code interfacing with Skein must adhere to these.

## Version & Documentation
- **bevy_skein 0.5** pinned — compatible with Bevy 0.18.1.
- API reference: <https://docs.rs/bevy_skein/latest/bevy_skein/>
- Guide & examples: <https://bevyskein.dev/>
- **Always consult official bevy_skein documentation before using any Skein API.** Do not assume patterns from memory — verify against current docs.

## Architecture Overview
- The Blender addon connects to a running Bevy app via the Bevy Remote Protocol (BRP) to fetch the type registry.
- Components are serialized through Bevy reflection into glTF `extras` fields.
- At load time, `SkeinPlugin` deserializes components from glTF extras and inserts them onto entities.
- Scene spawning uses standard Bevy `SceneRoot` — no special Skein spawn API needed.
- The registry is cached inside the `.blend` file; the Bevy app only needs to be running when component types change.

## Component Requirements for Skein
- All components exposed to Blender **must** derive `Reflect` and annotate `#[reflect(Component)]`.
- Derive `Default` and add `#[reflect(Component, Default)]` to enable Blender preset support.
- Use `#[type_path = "..."]` to provide stable identifiers exposed to Blender — avoids leaking internal crate paths and stays stable across refactors.
- All field types within a Skein-exposed component must also implement `Reflect`.
- Generic components or types from third-party crates require explicit `app.register_type::<T>()`.
- Third-party crate components must be reflected by those crates; Skein cannot force-reflect external types.

## Plugin Setup Conventions
- Add `SkeinPlugin::default()` to the app.
- `handle_brp` defaults to `true` in debug builds, `false` in release and WASM.
- BRP is entirely disabled on WASM targets — this is a design-time-only feature.
- For a custom BRP port, set `SkeinPlugin { handle_brp: false }` and manage `RemotePlugin` + `RemoteHttpPlugin` manually.
- Default BRP port: **15702**.

## Blender Workflow
- Define components in Bevy with proper reflection derives.
- Run the Bevy app in debug mode to start the BRP server.
- In Blender: fetch the remote type registry (Edit menu or Skein panel button).
- Apply components to objects, meshes, materials, lights, bones, or scenes via the Properties panel.
- Export as standard glTF/glb — Skein data embeds automatically in extras.
- In Bevy: spawn the scene with standard `SceneRoot` — components are already on entities.
- Re-fetch registry only when component types change; editing component values does not require re-fetch.

## Pitfalls & Rules
- Mesh and Material components may land on the same entity in Bevy — avoid applying the same component type to both a mesh and its material in Blender.
- Blender's default glTF export strips collection nodes — do not rely on collection-level components.
- BRP is disabled in release builds by default — if needed for staging tooling, set `handle_brp: true` explicitly.
- BRP is entirely unavailable on WASM targets.
- If BRP port 15702 is occupied, BRP fails silently — use a configurable port if conflicts arise.
- Verify BRP connectivity before debugging missing components — a silent port failure is the most common pitfall.

## Presets
- Use `insert_skein_preset` on `App` to register named preset component instances.
- Presets are served to Blender via the `skein/presets` BRP endpoint.
- Consult docs for preset registration patterns — do not guess the API shape.

## Material Replacement Pattern
- For swapping placeholder materials with Bevy materials at load time, use component hooks (`on_add`) — not systems or observers.
- This is the idiomatic pattern for reacting to Skein inserting components during scene loading.
- Consult bevy_skein docs and examples for the canonical implementation.
