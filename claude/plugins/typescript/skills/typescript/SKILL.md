---
name: typescript
description: TypeScript coding standards. Apply when writing or reviewing TypeScript or TSX files.
paths: "**/*.ts, **/*.tsx"
---

# TypeScript Coding Standards

## Strict Mode — Enforce

- NO `any` types — use proper interfaces or generics
- NO non-null assertions (`!`) — handle null explicitly
- NO `as unknown as T` casting — use type guards
- NO unused parameters — prefix with `_` to suppress
- Use `import type` for type-only imports
- Define interfaces for all props, state shapes, and API responses
- Type all error handling explicitly

### Forbidden patterns

```typescript
const data: any = fetchData();           // define an interface
const value = obj!.prop;                 // guard: if (obj) ...
const user = data as unknown as User;    // use a type guard function
```

## Interfaces and Types

- Prefer `interface` for object shapes that may be extended
- Use `type` for unions, intersections, and aliases
- Export types with `export type` — never export `any`
- Generic constraints: `<T extends SomeBase>` over unconstrained `<T>` where possible

## Type Guards

```typescript
function isUser(val: unknown): val is User {
  return typeof val === "object" && val !== null && "id" in val;
}
```

Use type guards at system boundaries (API responses, user input, `inject()` results).

## Parameter Destructuring

Destructure object parameters in callbacks and functions when you only need a few
fields — it names the fields at the signature and drops the noise of a placeholder
binding repeated at every use site.

```typescript
// Bad — placeholder name, repeated at every use
const active = data.items.find((c) => !c.archived && !c.expired);

// Good — fields named once, in the signature
const active = data.items.find(({ archived, expired }) => !archived && !expired);
```

Keep the whole object bound when you pass it along, need many fields, or must
narrow it with a type guard.

## Early Returns

The happy path is left-aligned. Handle guard conditions (missing input, invalid
state, no-op cases) with an early return at the top of the function so the main
logic sits at the outermost indentation level instead of nested inside
conditionals.

```typescript
// Bad — happy path buried in nesting
function process(order: Order | undefined): Receipt | undefined {
  if (order) {
    if (order.items.length > 0) {
      const total = sum(order.items);
      return buildReceipt(order, total);
    }
  }
  return undefined;
}

// Good — guards exit early, happy path reads straight down
function process(order: Order | undefined): Receipt | undefined {
  if (!order) return undefined;
  if (order.items.length === 0) return undefined;

  const total = sum(order.items);
  return buildReceipt(order, total);
}
```

Apply the same rule inside loops with `continue` and to `else` branches after a
`return` — drop the `else` and dedent.

## Error Handling

```typescript
try {
  const result = await fetchData();
} catch (err: unknown) {
  if (err instanceof Error) {
    console.error(err.message);
  }
}
```

Never catch as `any`. Always narrow `unknown` before use.

## Enums and Constants

- Prefer `const` object + `as const` over `enum` for string values — avoids duplicate declaration footguns
- If using `enum`, ensure there is only one declaration per name across the codebase; two `enum Foo` in different files with the same name is valid TypeScript but causes silent bugs when the wrong file is imported

```typescript
// Preferred
const Direction = { Up: "up", Down: "down" } as const;
type Direction = (typeof Direction)[keyof typeof Direction];
```

## String Conventions

```typescript
// Double quotes (project standard)
const message = "Hello world";
```
