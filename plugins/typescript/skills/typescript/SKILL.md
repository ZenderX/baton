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
