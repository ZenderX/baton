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

## General Coding Principles

### Code Quality Standards
- **User-Focused**: Prioritize accessibility, performance, and user experience
- **Pragmatic Solutions**: Choose simple, maintainable solutions over complex ones
- **Best Practices**: Optimize for performance, maintainability, readability, and modularity
- **Component Documentation**: Clear prop interfaces and emit definitions
- **Latest Versions**: Always use latest stable versions of libraries and frameworks
- **Completeness**: Generate full code, no placeholders. If unable, explain in comments
- **Type Completeness**: Be as type-complete as possible, avoid loose typing
- **Clean Code**: Ensure code is clean, readable, and maintainable
  - Use consistent naming conventions
  - Avoid unnecessary complexity and deeply nested structures
  - Ensure code is modular and reusable where possible
  - Use modern JavaScript/TypeScript features appropriately
- **Dead Code Removal**: Remove unused imports, variables, and deprecated features
- **Security-Conscious**: Always consider authentication and data protection
- **No Fallbacks**: Remove fallback strategies; implement in separate modules if necessary
- **Linting**: Always check for and follow existing ESLint, Prettier, or other linter/formatter configurations (.eslintrc, .eslintrc.cjs, .prettierrc, eslint.config.js, etc.)
- **Team-Oriented**: Write code that other developers can understand and extend

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

### Documentation Standards
- **File Headers**: Begin EVERY file with a JSDoc comment block explaining its purpose and role
- **Function Documentation**: Document EVERY function with JSDoc including inputs and outputs
- **Inline Comments**: Clarify purpose and implementation of non-obvious code segments
- **External Functions**: Comment external function calls with inputs, outputs, and purpose

### Error Handling
- **Error Checking**: Implement comprehensive error checking and type validation
- **Treat Warnings as Errors**: Address all compiler warnings
- **Graceful Degradation**: Handle error states with proper user feedback

### String Conventions
- **Quote Style**: Use double quotes (`"`) for strings consistently across the project
- **String Building**: Use template literals or `.join()` instead of concatenation
- **Interpolation**: Prefer template literals for dynamic string content