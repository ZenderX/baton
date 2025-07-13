---
description: TypeScript and Vue 3 coding standards
applyTo: "**/*.{ts,tsx,vue}"
---

# TypeScript & Vue 3 Standards

## TypeScript Requirements
- **Strict Mode**: No `any` types, no non-null assertions (`!`), no `as unknown` casting
- **Interface Definitions**: Define proper interfaces for component props and store state
- **Type Safety**: Use single quotes for strings, template literals for interpolation
- **Type Imports**: Use `import type` for type-only imports

## Vue 3 Patterns
- **Composition API**: Always use `<script setup>` syntax
- **Auto-imports**: Vue APIs (ref, reactive, computed, watch) are auto-imported via unplugin
- **Props**: Use `defineProps<Interface>()` with `withDefaults()` when needed
- **Emits**: Use `defineEmits<{ eventName: [payload: Type] }>()`
- **File Headers**: Every file must start with JSDoc comment explaining its purpose

## Component Standards
- **V-Prefix**: All reusable UI components use `V` prefix (`VButton`, `VInput`, `VCard`)
- **Icon Components**: Custom Vue components in `/src/components/icons/`
- **Testing**: Use `data-cy="element-name"` attributes for reliable test selection

## Authentication Integration
- Check `authStore.isAuthenticated` for auth state
- Use `authGuard` for protected routes
- Call `authStore.initialize()` on app startup
- Token refresh is handled automatically by `tokenService`

## Theme Integration
- Access theme via `useThemeStore().isDarkMode`
- Apply dark mode with Tailwind's `dark:` prefix
- Theme classes applied to `<html>` element, not body

## Notification System
- Use `useNotifications()` composable instead of `alert()`
- Provide user feedback for all async operations
- Handle error states gracefully with proper TypeScript types

## File Structure Conventions
```
src/
├── components/     # V-prefixed reusable components
├── composables/    # Reusable Vue logic
├── layouts/        # Page layouts
├── services/       # External integrations
├── stores/         # Pinia stores
├── utils/          # Pure functions and guards
└── views/          # Page components
```

## Testing Patterns
- **Unit tests**: `src/components/__tests__/*.spec.ts` using Vitest + Vue Test Utils
- **Component tests**: Cypress component testing with `.cy.ts` files
- **E2E tests**: `cypress/integration/*.spec.ts` with data-cy attributes
