---
name: bevy
description: Bevy 0.19.1 ECS conventions, plugin architecture, and gameplay patterns. Apply when writing or reviewing Bevy game code.
paths: "**/*.rs"
---

# Bevy 0.19.1 Conventions

Scope: Bevy engine conventions, ECS architecture, and gameplay patterns. Pure Rust standards live in the `rust` skill. All Bevy-touching `.rs` files must adhere to these.

## Version & Documentation
- Bevy **0.19.1** pinned — do not upgrade without migration review.
- Primary reference: <https://docs.rs/bevy/0.19.1/bevy/>
- Migration guides: <https://bevy.org/learn/migration-guides/>
- `bevy_egui` must be pinned at **0.40** for Bevy 0.19 — it is the only bevy_egui release that explicitly declares Bevy 0.19 compatibility (0.41/0.42 changelogs bump egui only).
- **Always consult official documentation before using any Bevy API.** Do not assume patterns from previous versions are still valid.

## 0.18 → 0.19 API changes (verified in migration)
- `DirectionalLight.shadows_enabled` → `shadow_maps_enabled` (0.19 also adds a separate `contact_shadows_enabled`).
- `Skybox.image` is now `Option<Handle<Image>>` — wrap assignments in `Some(..)`.
- `RenderCreation::Automatic` now takes `Box<WgpuSettings>`.
- `TextFont.font_size` is now the `FontSize` enum — use `FontSize::Px(n)` to preserve prior pixel values.
- `Camera3d` transmission fields moved to a separate `ScreenSpaceTransmission` component in `bevy_pbr`.
- `DespawnOnExit`/`DespawnOnEnter` can now trigger during **same-state** transitions — audit identity transitions before relying on despawn timing.
- `WGPU_SETTINGS_PRIO` env value renamed: `compatibility` → `webgpu` (old value silently no-ops).
- Text backend migrated Cosmic Text → Parley — re-verify any text rendering assumptions.

## Plugin Architecture
- Each gameplay domain gets its own plugin in `src/plugins/`.
- Simple plugin = single file (`src/plugins/player.rs`) containing a struct that implements `Plugin`.
- Complex plugin = directory with re-export (`src/plugins/player/` + `src/plugins/player.rs`), following the no-`mod.rs` convention.
- Plugin `build()` registers: components, resources, events, systems, states, observers.
- Keep side-effects contained within the plugin — no global mutable statics.
- Declare plugins in the parent module; document order-sensitive plugins with comments.
- Configuration via resource structs with `Default` implementations — inject before plugin `build()` runs.
- One plugin per domain; avoid monolithic "kitchen-sink" plugins.

## ECS Conventions
- **Components**: focused on a single data domain, keep small, derive `Debug`, `Clone`, `Reflect`.
- **Marker components**: zero-sized types for entity tagging (e.g., `struct Player;`).
- **Resources**: singular conceptual nouns — `TimeState`, `PlayerConfig`.
- **Events**: past tense or domain nouns — `DamageEvent`, `EntitySpawned`.
- **Messages**: use for pull-based cross-system communication where appropriate.
- Prefer required components over manual bundles.
- Spawn entities with tuple syntax.
- Keep component structs small — split large data into multiple components for query granularity.
- Derive `Reflect` on gameplay components to enable editor and debugging tooling.

## System Organization
- Systems use verb phrases: `update_velocity`, `animate_sprites`, `handle_input`.
- Group by phase: setup → input → simulation → physics → rendering → cleanup.
- Use `SystemSet`s with clear labels to define logical groups.
- Prefer explicit ordering (`.chain()`, `.before()`, `.after()`) over implicit schedule ordering.
- Use `.run_if()` for conditional execution — avoid manual early-returns in system bodies.
- Use `FixedUpdate` for deterministic simulation; `Update` for frame-rate-dependent visuals and input.

## State Management
- Use Bevy states for game flow (menu, playing, paused).
- Use `set_if_neq()` to avoid redundant same-state transitions — `set()` always fires transition logic, and in 0.19 `DespawnOnExit`/`DespawnOnEnter` fire on same-state transitions too.
- Gate systems with `in_state()` run conditions.

## Query Patterns
- Request `&mut` only when writing — read-only queries enable more parallelism.
- Use query filters (`With<T>`, `Without<T>`, `Changed<T>`, `Added<T>`) to narrow entity sets.
- Use change/added detection for reactive patterns instead of polling.
- Consult docs for `Single<T>` vs `Query<T>` trade-offs — prefer `Single` when exactly one entity is expected.

## Event-Driven Design
- Prefer events over polling resources for cross-system communication.
- Register events in plugin `build()` before systems that read or write them.
- Document event consumption patterns — note whether events are read once or by multiple systems.

## Asset Handling
- Load via `AssetServer`; store handles in resource structs — do not hold raw paths at runtime.
- Validate asset presence; log missing assets at `warn!` level.
- Consult 0.19.1 docs — asset APIs changed significantly from previous versions. `AssetServer::load_with_settings` is deprecated in 0.19: use `load_builder().with_settings(..).load(path)`.

## Input Handling
- Use `ButtonInput<KeyCode>` for keyboard, `ButtonInput<MouseButton>` for mouse.
- Consult docs for current key code names and input patterns — these change across Bevy versions.

## WASM Guidelines
- Keep synchronous blocking out of WASM — no `std::thread`, no `std::time::Instant`.
- Minimize allocation churn in hot loops; reuse buffers.
- Avoid large recursion — WASM has limited stack size.
- Use `console_error_panic_hook` for error reporting in browser builds.
- **Dropping a `Task<T>` in web builds cancels it** (0.19 change) — call `Task::detach()` if you need the old run-to-completion behavior.
- Consult Bevy WASM documentation for build setup and feature flags.
- Test in browser regularly — do not defer WASM validation to the end.

## Rendering Conventions
- Consult 0.19.1 docs — several rendering APIs changed (`RenderTarget`, `AmbientLight`, camera APIs, render graph now systems-based, etc.).
- WGSL shader imports of `bevy_pbr::` modules break at **runtime only** — a Bevy upgrade must include a visual smoke test; `cargo check` cannot catch shader import breakage.
- Do not assume previous Bevy version patterns for rendering.
- Use feature collections (`"3d"`) for dependency management — pin features explicitly, e.g. `features = ["3d"]`.

## Observers & Hooks
- Use observers for entity-targeted event observation.
- Use component hooks (`on_add`, `on_remove`, `on_insert`) for lifecycle management.
- Consult docs for current observer and hook API — these are newer and evolving.

## Time
- Use Bevy `Time` resource, never `std::time::Instant` (especially in WASM).
- Use `delta_secs()` for frame delta time.
- `FixedUpdate` for deterministic simulation — physics, tick-based logic.

## Review Checklist
- All systems registered in a plugin — no orphan systems.
- Events registered before use.
- States initialized with a default value.
- No deprecated APIs — verify against 0.19.1 docs.
- Clippy clean (`cargo clippy --all-targets --all-features -D warnings`).
- Tests pass (`cargo test`).
- WASM build compiles if targeting web (`cargo build --target wasm32-unknown-unknown`).
- Run conditions and ordering constraints reviewed for correctness.
