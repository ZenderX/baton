---
description: TypeScript and Vue 3 coding standards
applyTo: "**/*.{ts,tsx,vue}"
---

# TypeScript & Vue 3 Coding Standards

## TypeScript Requirements
- **Strict Mode**: No `any` types, no non-null assertions (`!`), no `as unknown` casting
- **Interface Definitions**: Define proper interfaces for component props and store state
- **Type Safety**: Use double quotes for strings, template literals for interpolation (TypeScript override for consistency)
- **Type Imports**: Use `import type` for type-only imports
- **Error Handling**: Implement proper error checking and type validation
- **Type-Safe Error Handling**: Handle error states with proper TypeScript type annotations
- **Naming**: Use intuitive naming conventions and consistent patterns

## Vue 3 Patterns
- **Composition API**: Always use `<script setup>` syntax
- **Auto-imports**: Vue APIs (ref, reactive, computed, watch) are auto-imported via unplugin
- **Props**: Use `defineProps<Interface>()` with `withDefaults()` when needed
- **Emits**: Use `defineEmits<{ eventName: [payload: Type] }>()`
- **Reactivity**: Use appropriate reactive primitives (ref vs reactive vs computed)
- **Lifecycle**: Use composition API lifecycle hooks (onMounted, onUnmounted, etc.)

## Code Quality Standards
- **Type Completeness**: Be as type-complete as possible, avoid loose typing
- **Component Documentation**: Clear prop interfaces and emit definitions
- **Project Standards**: Always check for and follow existing ESLint, Prettier, or other linter/formatter configurations (.eslintrc, .prettierrc, eslint.config.js, etc.)

## Component Standards
- **Props Typing**: Always type component props with interfaces
- **Event Typing**: Type custom events with proper payload types
- **Slot Typing**: Define slot types when using complex slot patterns
- **Template Refs**: Type template references properly

## Testing Standards
- **Test Typing**: Use proper TypeScript in test files
- **Mock Typing**: Type mocks and test utilities correctly
- **Test Data**: Create typed test data and fixtures
- **Assertion Types**: Use type-safe test assertions
