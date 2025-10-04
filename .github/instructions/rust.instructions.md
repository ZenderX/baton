---
description: Rust coding, Bevy patterns, WASM, and plugin architecture standards for the project
applyTo: "**/*.rs"
---

# Rust & Bevy Coding Standards

Scope: These rules govern Rust style, architecture patterns, Bevy engine usage, plugin design, multi-target (native + WASM) concerns, safety, performance, and documentation. They complement `project.instructions.md` and language-specific files (e.g., TypeScript for web bindings). All Rust code in `src/` and root-level Rust binaries must adhere to these.

## Core Principles
- **Clarity Over Cleverness**: Readability, explicit intent, minimal magic.
- **Data-Oriented Where Beneficial**: Favor ECS-friendly layouts (bundles, components, resources) for cache efficiency while retaining clarity.
- **Extensibility**: Game systems must be modular, hot-reload friendly (where feasible), and plugin-composable.
- **Determinism**: Isolate randomness; seedable RNG for gameplay-critical logic.
- **Cross-Target Compatibility**: Minimize `cfg` gating; confine platform-specific code to narrow modules.
- **No Unsafe by Default**: `unsafe` blocks require a preceding safety comment justifying invariants.
- **Performance Mindfulness**: Measure before optimizing; prefer algorithmic gains over micro-optimizations.

## File & Module Conventions
- One primary concept per file (component, system group, plugin).
- `mod.rs` acceptable only when grouping small cohesive modules; prefer `modname/mod.rs` with submodules for larger domains.
- Public API surface (`pub use`) at crate root (`lib.rs`) for commonly used types; avoid deep import chains in consumers.
- Use `crate::` paths internally; avoid relative `super::super` chains.

## Naming & Structure
- Types: `PascalCase`; modules & files: `snake_case`.
- Components end with `Component` only if disambiguation is needed; otherwise omit redundancy (e.g., `Velocity`, not `VelocityComponent`).
- Systems use verb phrases: `update_velocity`, `animate_sprites`.
- Resources: singular conceptual noun (`TimeState`, `PlayerConfig`).
- Events: past tense or domain noun (`DamageEvent`, `EntitySpawned`).

## Plugin Architecture
- Each gameplay domain gets a plugin in `src/plugins/` (e.g., `player`, `world`, `ui`).
- Plugin file exports a struct implementing `Plugin` with:
  - `fn build(&self, app: &mut App)` registering: components, resources (with defaults), events, systems, schedules, asset loaders.
  - Optional configuration struct for tunables.
- Keep plugin side-effects contained; no global mutable statics.
- Re-export plugin entry types in `plugins/mod.rs`.
- Order-sensitive plugins documented with explicit comment above their addition in `lib.rs`.

### System Organization
- Group logically by phase: setup, input, simulation, physics, rendering orchestration, cleanup.
- Use `SystemSet`s & schedules with clear labels; avoid hard-coded ordering unless required—prefer explicit `after` / `before`.
- Prefer fixed timestep for deterministic simulation-critical systems if needed (use `FixedUpdate`).

### Hot Reload (Asset / Logic)
- Enable Bevy asset hot-reload during development (detect env / feature flag if necessary).
- Logic hot reload via dynamic plugins is experimental—gate behind feature flags and isolate unsafe / FFI boundaries.

## ECS Best Practices
- Minimize component size; store large collections in resources or assets.
- Derive common traits: `Debug`, `Clone` (when cheap), `Copy` (when trivially copyable), `Reflect` (when using reflection / serialization), `serde::{Serialize, Deserialize}` where persistence required.
- Avoid inserting many one-off marker components if an enum on a shared component suffices (evaluate cardinality & query patterns).
- Use queries sparingly inside tight loops; batch work when possible.

## Error Handling
- Use `anyhow::Result<T>` (add dep if not present) at application boundaries (CLI, top-level plugin init). Internals: define domain-specific error enums with `thiserror` (add if/when needed).
- Never silently ignore errors; log with context.
- For recoverable issues, return `Result` or emit an event; for unrecoverable invariants, use `panic!` only if corruption would occur.
- WASM environment: avoid panics—prefer graceful degradation & console logging via `console_error_panic_hook` (already included).

## Logging & Diagnostics
- Use `bevy::log` macros: `info!`, `warn!`, `error!`, `debug!`, `trace!`.
- Provide category via target when useful: `info!(target: "ai.nav", "Rebuilt navmesh: {size}")`.
- Use `tracing` integration if advanced spans become necessary (feature gated).

## Configuration & Features
- Feature flags control optional subsystems (e.g., `dev-server`). Document each in `Cargo.toml` with comments.
- Avoid sprawling cfgs in logic; isolate platform specifics:
  ```rust
  #[cfg(target_arch = "wasm32")]
  fn web_only() { /* ... */ }
  ```
- Provide thin abstraction wrappers if platform divergence grows.

## WASM Guidelines
- Keep synchronous blocking out of WASM—use `wasm_bindgen_futures::spawn_local` for async tasks.
- Minimize allocation churn; WASM GC pressure differs from native.
- Optimize final `.wasm` via `wasm-opt` (Binaryen) in release workflows (script-based).
- Avoid large recursion (stack limits).

## Randomness & Determinism
- Centralize RNG resource if deterministic seeds needed.
- Use `rand` with explicit RNG types (e.g., `StdRng`) rather than thread-local implicit when determinism matters.

## Asset Handling
- Declare asset loading stages; avoid ad-hoc handles stored widely—wrap in resource structs.
- Validate asset presence; log missing assets clearly.

## Safety & Unsafe Code
- For every `unsafe` block:
  - Precede with `// SAFETY: <invariants>` comment.
  - Minimize scope—extract to function if multi-line.
  - Prefer safe abstractions first.

## Performance Practices
- Benchmark hotspots with `cargo bench` (add criterion setup when needed).
- Avoid per-frame heap allocations in core loops (reuse buffers, use `SmallVec` if appropriate—add dependency as needed).
- Use `With<Marker>` or `Without<Marker>` query filters thoughtfully—broad queries can be expensive.
- Profile both native and WASM builds; differences can guide layout changes.

## Testing Strategy
- Unit tests colocated with modules using `#[cfg(test)] mod tests { ... }`.
- Integration tests in `tests/` for plugin interplay / ECS flows.
- Deterministic seeds for simulation tests.
- Use snapshot tests only for stable textual outputs.
- Keep tests fast; isolate slow / heavy tests with `#[ignore]` and document reason.

## Documentation Standards
- File header doc comment (//! …) summarizing purpose; crate root (`lib.rs`) has high-level architecture map.
- Public items documented with `///`; include examples where non-trivial.
- Complex systems: add architecture comment block describing data flow & scheduling.
- Explain invariants & safety conditions inline.

## Lints & Style
- Deny common footguns in crate root:
  ```rust
  #![deny(unsafe_op_in_unsafe_fn, unused_must_use, rust_2018_idioms)]
  #![warn(clippy::all, clippy::pedantic)]
  ```
- Allow specific pedantic lints locally when justification documented.
- Run `cargo clippy --all-targets --all-features -D warnings` before commit.
- Format with `cargo fmt` (stable default style) and keep builds green.

## Dependency Hygiene
- Prefer small, focused crates; justify large deps (e.g., physics engines) in PR description.
- Keep versions updated; avoid duplicate major versions.
- Remove unused transitive feature bloat—specify feature lists explicitly.

## Build Profiles & Scripts
- Respect existing `profile` settings; do not lower release optimizations.
- Scripts (`scripts/*.sh`) unify native vs WASM; avoid duplicating logic inside Rust for build selection.

## Event-Driven Design
- Use Bevy `Events<T>` for decoupling subsystems.
- Avoid polling resources every frame when an event suffices.
- Clear events consumption patterns—document when events persist multiple frames.

## Time & Scheduling
- Use Bevy `Time` resource; avoid `std::time::Instant` directly in WASM context.
- Fixed timestep for physics-like consistency; variable update acceptable for visuals.

## Serialization & Persistence
- Use `serde` for save data; keep versioning via explicit `version: u32` fields.
- Migrate with layered enums or explicit upgrade functions.

## Security Considerations
- Never trust external JS / WASM interop inputs; validate length & bounds.
- Avoid panics from user-driven input; sanitize.
- No dynamic code execution from untrusted sources.

## Panic & Error Reporting
- Attach `console_error_panic_hook` on WASM startup (ensure once-only install).
- Provide user-friendly fallback messaging (UI overlay) for critical runtime failures (future enhancement).

## Metrics & Telemetry (Future)
- Design resources with potential instrumentation points; keep IDs stable.

## Refactoring Guidelines
- Maintain backward-compatible plugin public APIs where feasible.
- Document breaking changes in CHANGELOG (add if not present) or commit message body.

## Review Checklist (Pre-merge)
- [ ] No `todo!()` / `unimplemented!()` in production paths.
- [ ] All `unsafe` justified.
- [ ] Clippy clean at `-D warnings`.
- [ ] Tests pass (native + WASM core logic if applicable via `wasm-bindgen-test`).
- [ ] Docs updated & examples compile (`cargo test --doc`).
- [ ] No unnecessary allocations in hot paths.

## Example Plugin Skeleton
```rust
//! Player movement plugin: handles input -> velocity -> translation.
use bevy::prelude::*;

pub struct PlayerPlugin;

impl Plugin for PlayerPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<PlayerConfig>()
            .add_event::<PlayerSpawned>()
            .add_systems(Startup, setup_player)
            .add_systems(Update, (handle_input, apply_velocity).chain());
    }
}

#[derive(Resource)]
struct PlayerConfig {
    max_speed: f32,
}
impl Default for PlayerConfig { fn default() -> Self { Self { max_speed: 400.0 } } }

#[derive(Event, Debug)]
struct PlayerSpawned(Entity);

#[derive(Component, Debug, Default)]
struct Velocity(Vec2);

fn setup_player(mut commands: Commands, mut ev: EventWriter<PlayerSpawned>) {
    let entity = commands.spawn((SpriteBundle::default(), Velocity::default())).id();
    ev.send(PlayerSpawned(entity));
}

fn handle_input(keys: Res<Input<KeyCode>>, mut q: Query<&mut Velocity>) {
    for mut vel in &mut q { let mut d = Vec2::ZERO; if keys.pressed(KeyCode::W) { d.y += 1.0; } if keys.pressed(KeyCode::S) { d.y -= 1.0; } if keys.pressed(KeyCode::A) { d.x -= 1.0; } if keys.pressed(KeyCode::D) { d.x += 1.0; } vel.0 = d.normalize_or_zero() * 400.0; }
}

fn apply_velocity(time: Res<Time>, mut q: Query<(&mut Transform, &Velocity)>) {
    for (mut transform, vel) in &mut q { transform.translation += (vel.0 * time.delta_seconds()).extend(0.0); }
}
```

## Adding New Code
1. Plan: define data (components/resources/events) before systems.
2. Start with minimal vertical slice; compile early.
3. Add tests for deterministic logic separately from rendering.
4. Run formatting + clippy.
5. Document public surface.

---
These standards evolve—propose improvements via PR with justification referencing performance, safety, or clarity gains.
