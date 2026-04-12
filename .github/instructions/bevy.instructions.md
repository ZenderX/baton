---
description: "Bevy 0.18.1 conventions, patterns, and architecture standards"
applyTo: "**/*.rs"
---

# Bevy 0.18.1 Conventions

Scope: Bevy engine conventions, ECS architecture, and gameplay patterns. Pure Rust standards live in `rust.instructions.md`. All Bevy-touching `.rs` files must adhere to these.

## Version & Documentation
- Bevy **0.18.1** pinned — do not upgrade without migration review.
- Primary reference: <https://docs.rs/bevy/0.18.1/bevy/>
- Migration guides: <https://bevyengine.org/learn/migration-guides/>
- **Always consult official documentation before using any Bevy API.** Do not assume patterns from previous versions are still valid.

## Plugin Architecture
- Each gameplay domain gets its own plugin in `src/plugins/`.
- Simple plugin = single file (`src/plugins/player.rs`) containing a struct that implements `Plugin`.
- Complex plugin = directory with re-export (`src/plugins/player/` + `src/plugins/player.rs`), following the no-`mod.rs` convention from `rust.instructions.md`.
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
- Use `set_if_neq()` to avoid redundant same-state transitions — `set()` always fires transition logic in 0.18.1.
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
- Consult 0.18.1 docs — asset APIs changed significantly from previous versions.

## Input Handling
- Use `ButtonInput<KeyCode>` for keyboard, `ButtonInput<MouseButton>` for mouse.
- Consult docs for current key code names and input patterns — these change across Bevy versions.

## WASM Guidelines
- Keep synchronous blocking out of WASM — no `std::thread`, no `std::time::Instant`.
- Minimize allocation churn in hot loops; reuse buffers.
- Avoid large recursion — WASM has limited stack size.
- Use `console_error_panic_hook` for error reporting in browser builds.
- Consult Bevy WASM documentation for build setup and feature flags.
- Test in browser regularly — do not defer WASM validation to the end.

## Rendering Conventions
- Consult 0.18.1 docs — several rendering APIs changed (`RenderTarget`, `AmbientLight`, camera APIs, etc.).
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
- No deprecated APIs — verify against 0.18.1 docs.
- Clippy clean (`cargo clippy --all-targets --all-features -D warnings`).
- Tests pass (`cargo test`).
- WASM build compiles if targeting web (`cargo build --target wasm32-unknown-unknown`).
- Run conditions and ordering constraints reviewed for correctness.

---
These conventions evolve — propose improvements via PR with justification. When Bevy updates, review migration guides and update this file.
