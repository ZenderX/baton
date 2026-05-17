---
description: "Rust coding standards and conventions for the project"
applyTo: "**/*.rs"
---

# Rust Coding Standards

Scope: Pure Rust language standards — style, safety, error handling, testing, and tooling. Framework-specific patterns live in dedicated instruction files. All `.rs` files must adhere to these.

## Version & Documentation
- **Rust 1.94.1** — pinned toolchain version for this project.
- **Standard library reference:** [std docs](https://doc.rust-lang.org/stable/std/index.html)
- Always consult official Rust documentation before using any standard library API. Do not assume patterns from memory — verify against current docs.

## Core Principles
- **Clarity over cleverness** — readability, explicit intent, minimal magic.
- **Safety first** — no `unsafe` by default; safe abstractions always preferred.
- **Performance mindfulness** — measure before optimizing; prefer algorithmic gains over micro-optimizations.
- **Cross-target compatibility** — minimize `cfg` gating; confine platform-specific code to narrow modules.
- **Determinism** — isolate randomness; use seedable RNG types when reproducibility matters.

## File & Module Conventions
- Rust 2024 edition.
- **Use `mod_name.rs` not `mod_name/mod.rs`** — only create a directory when you need multiple submodule files.
- One primary concept per file.
- Public API surface (`pub use`) at crate root for commonly used types; avoid deep import chains.
- Use `crate::` paths internally; never chain `super::super`.
- Avoid circular dependencies between modules; use trait-based decoupling if needed.
- Keep `mod` declarations organized alphabetically in parent modules.

## Naming Conventions
- **Types**: `PascalCase` — structs, enums, traits.
- **Modules, files, functions, variables**: `snake_case`.
- **Constants & statics**: `SCREAMING_SNAKE_CASE`.
- Functions use verb phrases describing the action: `update_velocity`, `parse_config`.
- Avoid redundant suffixes (e.g., `Velocity` not `VelocityStruct`).
- Boolean variables/fields prefixed with `is_`, `has_`, `should_`, or similar.
- Type parameters: single uppercase letter for simple generics (`T`, `E`); descriptive name for complex bounds.

## Error Handling
- `thiserror` for domain-specific error enums in library/internal code.
- `anyhow::Result` at application boundaries (CLI, top-level init).
- Never silently ignore errors — log with context or propagate.
- `Result` for recoverable issues; `panic!` only for unrecoverable invariant corruption.
- Prefer `?` operator for propagation; avoid nested `match` on `Result` when unnecessary.
- Error messages should be lowercase, without trailing punctuation, and descriptive.
- Map errors with `.context()` or `.with_context()` to add stack-relevant information.

## Safety & Unsafe
- Every `unsafe` block requires a preceding `// SAFETY: <invariants>` comment.
- Minimize `unsafe` scope — extract to a small function if multi-line.
- Prefer safe abstractions first; only drop to `unsafe` when no safe alternative exists.
- Audit all `unsafe` during review — treat as high-priority.
- Never trust external inputs inside `unsafe` blocks; validate bounds and invariants.

## Logging
- Use `tracing` macros: `info!`, `warn!`, `error!`, `debug!`, `trace!`.
- Provide category via `target` when useful: `info!(target: "network", "connected to {addr}")`.
- Structured fields preferred over string interpolation for machine-parseable logs.
- `debug!` / `trace!` for high-frequency or inner-loop diagnostics; `info!` for lifecycle events.
- Never log secrets, credentials, or sensitive user data.

## Testing
- Unit tests colocated with source: `#[cfg(test)] mod tests { ... }`.
- Integration tests in `tests/` directory for cross-module flows.
- Deterministic seeds for any simulation or randomness-dependent tests.
- Keep tests fast; mark slow tests with `#[ignore]` and document the reason.
- Use snapshot tests only for stable textual outputs.
- Test error paths — not just the happy path.
- Assertions should include descriptive messages for non-obvious checks.

## Lints & Formatting
- Deny common footguns in crate root:
  ```rust
  #![deny(unsafe_op_in_unsafe_fn, unused_must_use)]
  #![warn(clippy::all, clippy::pedantic)]
  ```
- Allow specific pedantic lints locally only with documented justification.
- Run `cargo clippy --all-targets --all-features -D warnings` before commit.
- Run `cargo fmt` (stable default style) before commit; keep builds green.
- No `todo!()` or `unimplemented!()` in production paths.

## Dependency Hygiene
- Prefer small, focused crates; justify large dependencies in PR description.
- Keep versions updated; avoid duplicate major versions in the dependency tree.
- Remove unused transitive feature bloat — specify feature lists explicitly.
- Feature flags control optional subsystems; document each in `Cargo.toml` with comments.
- Avoid sprawling `cfg` in logic; isolate platform-specific code behind thin abstraction wrappers.

## Documentation
- File header doc comment (`//!`) summarizing purpose.
- Crate root (`lib.rs` / `main.rs`) includes high-level architecture overview.
- Public items documented with `///`; include examples for non-trivial APIs.
- Explain invariants and safety conditions inline.
- Document breaking changes in commit message body or CHANGELOG.

## Serialization
- Use `serde` for persistence data.
- Include explicit `version: u32` (or similar) fields for migration support.
- Migrate with layered enums or explicit upgrade functions.
- Validate deserialized data at boundaries; do not trust serialized input blindly.

## Performance
- Benchmark hotspots with `cargo bench` (criterion when needed).
- Avoid per-iteration heap allocations in hot loops — reuse buffers.
- Prefer `SmallVec` or stack allocation for small, bounded collections in tight paths.
- Profile before committing to optimization; data wins over intuition.
- Avoid unnecessary cloning; prefer borrowing and reference-counted types where ownership is shared.

## Trait & Type Design
- Derive common traits where appropriate: `Debug`, `Clone` (when cheap), `Copy` (when trivially copyable).
- Add `serde::{Serialize, Deserialize}` only where persistence is required.
- Keep types small and focused on a single responsibility.
- Prefer composition over deep inheritance-like trait hierarchies.
- Use newtypes to enforce type safety for domain values (e.g., `struct Meters(f32)`).

## Common Patterns
- Prefer iterators and combinators over manual loops when clarity is maintained.
- Use `impl Into<T>` / `AsRef<T>` for flexible function signatures at API boundaries.
- Avoid `String` parameters when `&str` suffices; minimize unnecessary cloning.
- Use `enum` over boolean flags when more than two states are possible.
- Prefer `match` exhaustiveness — avoid wildcard `_` catch-alls on enums to catch new variant additions.
- Use `Default` trait for types with natural default state.

---
These standards evolve — propose improvements via PR with justification referencing performance, safety, or clarity gains.

