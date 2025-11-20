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
- **Use `mod_name.rs` instead of `mod_name/mod.rs`**: Rust 2018+ prefers `src/plugins/player.rs` over `src/plugins/player/mod.rs` for single-file modules. Only create a directory `src/plugins/player/` with submodules when you need multiple implementation files.
- For complex plugins with multiple submodules, use the directory structure:
  ```
  src/plugins/
    player.rs              # Re-exports from player/ submodules
    player/
      components.rs
      systems.rs
      resources.rs
      plugin.rs
  ```
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
- Plugin structure options:
  - **Simple plugin**: Single file `src/plugins/player.rs` with `pub struct PlayerPlugin;`
  - **Complex plugin**: Directory `src/plugins/player/` with re-export file at `src/plugins/player.rs`
- Plugin file exports a struct implementing `Plugin` with:
  - `fn build(&self, app: &mut App)` registering: components, resources (with defaults), events, systems, schedules, asset loaders.
  - Optional configuration struct for tunables.
- Keep plugin side-effects contained; no global mutable statics.
- Declare plugins in parent module (e.g., `src/plugins.rs`) with `pub mod player;` and optionally re-export with `pub use player::PlayerPlugin;`.
- Order-sensitive plugins documented with explicit comment above their addition in `lib.rs` or `main.rs`.

### System Organization
- Group logically by phase: setup, input, simulation, physics, rendering orchestration, cleanup.
- Use `SystemSet`s & schedules with clear labels; avoid hard-coded ordering unless required—prefer explicit `after` / `before`.
- Prefer fixed timestep for deterministic simulation-critical systems if needed (use `FixedUpdate`).
- **System Chaining**: Use `.chain()` to ensure systems run in order: `(sys_a, sys_b, sys_c).chain()`.
- **System Ordering**: Use `.before(other_system)` and `.after(other_system)` for explicit dependencies.
- **Run Conditions**: Use `.run_if()` to conditionally execute systems based on state or resources.
- **Schedule Execution Order**: `Startup` → `First` → `PreUpdate` → `StateTransition` → `RunFixedMainLoop` → `Update` → `PostUpdate` → `Last`.
- **Example**:
  ```rust
  app.add_systems(Update, (
      handle_input,
      (update_physics, apply_forces).chain(),
      render_sprites.after(update_physics)
  ));
  ```

## Input Handling (Bevy 0.17)
- **ButtonInput<T>**: Use `Res<ButtonInput<KeyCode>>` instead of deprecated `Input<KeyCode>`.
- **KeyCode Changes**: Key codes now use descriptive names: `KeyCode::KeyW`, `KeyCode::KeyA`, `KeyCode::KeyS`, `KeyCode::KeyD` (not `KeyCode::W`, etc.).
- **Mouse Buttons**: Use `ButtonInput<MouseButton>` for mouse input.
- **Query Methods**: `.pressed()`, `.just_pressed()`, `.just_released()` remain the same.
- **Example**:
  ```rust
  fn handle_input(keys: Res<ButtonInput<KeyCode>>) {
      if keys.pressed(KeyCode::Space) { /* ... */ }
      if keys.just_pressed(KeyCode::Enter) { /* ... */ }
  }
  ```

### Hot Reload (Asset / Logic)
- Enable Bevy asset hot-reload during development (detect env / feature flag if necessary).
- Logic hot reload via dynamic plugins is experimental—gate behind feature flags and isolate unsafe / FFI boundaries.

## ECS Best Practices
- Minimize component size; store large collections in resources or assets.
- Derive common traits: `Debug`, `Clone` (when cheap), `Copy` (when trivially copyable), `Reflect` (when using reflection / serialization), `serde::{Serialize, Deserialize}` where persistence required.
- Avoid inserting many one-off marker components if an enum on a shared component suffices (evaluate cardinality & query patterns).
- Use queries sparingly inside tight loops; batch work when possible.
- **Bevy 0.17 Required Components**: Use `app.register_required_components::<ParentComponent, ChildComponent>()` to ensure components are always spawned together. This reduces boilerplate and prevents forgetting component pairs.
- **Component Bundles**: Prefer individual component insertion with required components over manual bundles in Bevy 0.17+. Use `commands.spawn((ComponentA, ComponentB))` pattern.
- **Spawn Pattern**: Use tuple syntax for spawning: `commands.spawn((Sprite::default(), Transform::default(), CustomComponent))` instead of bundles.

## Component Organization
- **Marker Components**: Use zero-sized types with `#[derive(Component)]` for entity tagging.
- **Data Components**: Keep components focused on a single data domain (position, velocity, health, etc.).
- **Component Constructors**: Provide `Default` implementations or constructor functions for complex components.
- **Component Groups**: When components always appear together, consider `register_required_components` instead of bundles.

## Query Patterns & System Parameters
- **Single<T>**: Use `Single<&T>` or `Single<&mut T>` for queries that expect exactly one result (panics if zero or multiple).
- **Option<Single<T>>**: Use when a single entity might not exist yet (returns `None` if zero results, panics if multiple).
- **Query Filters**: Use `With<T>`, `Without<T>`, `Or<(With<A>, With<B>)>` to filter entities efficiently.
- **Changed Detection**: Use `Query<&T, Changed<T>>` to process only entities where component T changed.
- **Added Detection**: Use `Query<&T, Added<T>>` for newly added components.
- **Mutability**: Request `&mut` only when needed—read-only queries enable more parallelism.

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
- **Development**: Use `trunk serve` for local development with hot-reloading (configured in `Trunk.toml`).
- **Build**: Use `trunk build --release` for production WASM builds.
- Keep synchronous blocking out of WASM—use `wasm_bindgen_futures::spawn_local` for async tasks.
- Minimize allocation churn; WASM GC pressure differs from native.
- Trunk automatically handles `wasm-opt` optimization in release builds.
- Avoid large recursion (stack limits).
- **Asset Paths**: Assets are automatically copied by Trunk; reference them relative to the project root.

## Randomness & Determinism
- Centralize RNG resource if deterministic seeds needed.
- Use `rand` with explicit RNG types (e.g., `StdRng`) rather than thread-local implicit when determinism matters.

## Asset Handling
- Declare asset loading stages; avoid ad-hoc handles stored widely—wrap in resource structs.
- Validate asset presence; log missing assets clearly.
- **Asset Loading Pattern**: Use `AssetServer` resource to load assets, store `Handle<T>` in resources.
- **Hot Reloading**: Asset hot-reloading is enabled by default in dev builds; test changes without restart.

## Observers & Hooks (Bevy 0.17)
- **Component Hooks**: Use `on_add`, `on_insert`, `on_remove` hooks for component lifecycle management.
- **Observers**: Use `app.observe()` for entity-targeted event observation (complements global events).
- **Hook Example**:
  ```rust
  app.world_mut()
      .register_component_hooks::<MyComponent>()
      .on_add(|mut world, entity, _component_id| {
          // Custom logic when component is added
      });
  ```

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
- **Native builds**: Use `cargo run` for development, `cargo build --release` for production.
- **WASM builds**: Use `trunk serve` for development with hot-reload, `trunk build --release` for production.
- Trunk configuration is in `Trunk.toml`; avoid duplicating build logic.

## Event-Driven Design
- Use Bevy `Events<T>` for decoupling subsystems.
- Avoid polling resources every frame when an event suffices.
- Clear events consumption patterns—document when events persist multiple frames.
- **Event Registration**: Use `app.add_event::<MyEvent>()` in plugin's `build()` method.
- **Event Readers**: Use `EventReader<T>` system parameter to read events; automatically clears after all systems process.
- **Event Writers**: Use `EventWriter<T>` to send events; prefer events over direct resource mutation for cross-system communication.

## State Management (Bevy 0.17)
- **States**: Use `app.init_state::<MyState>()` to register state machines.
- **State Transitions**: Use `NextState<T>` resource to trigger state changes: `next_state.set(MyState::NewState)`.
- **Schedule Triggers**: Systems can run `OnEnter(state)`, `OnExit(state)`, or conditionally with `in_state(state)`.
- **Sub-States**: Different state types can coexist independently (e.g., `GameState` and `MenuState`).
- **Example**:
  ```rust
  app.init_state::<GameState>()
      .add_systems(OnEnter(GameState::MainMenu), setup_menu)
      .add_systems(OnExit(GameState::MainMenu), cleanup_menu)
      .add_systems(Update, game_logic.run_if(in_state(GameState::Playing)));
  ```

## Time & Scheduling
- Use Bevy `Time` resource; avoid `std::time::Instant` directly in WASM context.
- **Bevy 0.17**: Use `time.delta_secs()` instead of deprecated `time.delta_seconds()`.
- Fixed timestep for physics-like consistency; variable update acceptable for visuals.
- Use `FixedUpdate` schedule for deterministic simulation systems.

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
impl Default for PlayerConfig { 
    fn default() -> Self { 
        Self { max_speed: 400.0 } 
    } 
}

#[derive(Event, Debug)]
struct PlayerSpawned(Entity);

#[derive(Component, Debug, Default)]
struct Velocity(Vec2);

fn setup_player(mut commands: Commands, mut ev: EventWriter<PlayerSpawned>) {
    let entity = commands.spawn((
        Sprite::default(),
        Transform::default(),
        Velocity::default(),
    )).id();
    ev.send(PlayerSpawned(entity));
}

fn handle_input(keys: Res<ButtonInput<KeyCode>>, mut q: Query<&mut Velocity>) {
    for mut vel in &mut q {
        let mut d = Vec2::ZERO;
        if keys.pressed(KeyCode::KeyW) { d.y += 1.0; }
        if keys.pressed(KeyCode::KeyS) { d.y -= 1.0; }
        if keys.pressed(KeyCode::KeyA) { d.x -= 1.0; }
        if keys.pressed(KeyCode::KeyD) { d.x += 1.0; }
        vel.0 = d.normalize_or_zero() * 400.0;
    }
}

fn apply_velocity(time: Res<Time>, mut q: Query<(&mut Transform, &Velocity)>) {
    for (mut transform, vel) in &mut q {
        transform.translation += (vel.0 * time.delta_secs()).extend(0.0);
    }
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
