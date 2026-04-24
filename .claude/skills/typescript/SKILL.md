---
name: typescript
description: TypeScript and Vue 3 coding standards. Apply when writing or reviewing TypeScript, TSX, or Vue files.
paths: "**/*.ts, **/*.tsx, **/*.vue"
---

# TypeScript & Vue 3 Coding Standards

Language-specific rules for TypeScript and Vue 3. Architecture, state management, and project patterns in `project.instructions.md`.

## TypeScript Strict Mode

### Enforce

- NO `any` types (use proper interfaces/types)
- NO non-null assertions (`!`)
- NO `as unknown` casting (except for documented dependency version conflicts)
- NO unused parameters (prefix with `_` to ignore)
- Use `import type` for type-only imports
- Define interfaces for component props and store state
- Type all error handling with proper annotations

### Forbidden (unless documented exception)

```typescript
const data: any = fetchData();           // Use proper interface
const value = obj!.prop;                 // Handle null explicitly
const user = data as unknown as User;    // Use type guards
```

## Vue 3 Composition API

### Script Setup (REQUIRED)

```vue
<script setup lang="ts">
// Always use <script setup>
// Auto-imports: ref, reactive, computed, watch (via unplugin)

interface Props {
  title: string;
  count?: number;
}

const props = withDefaults(defineProps<Props>(), {
  count: 0
});

const emit = defineEmits<{
  update: [value: number];
  close: [];
}>();
</script>
```

### Component Typing

- Props: `defineProps<Interface>()` with `withDefaults()` for optionals
- Emits: `defineEmits<{ eventName: [payload: Type] }>()`
- Template refs: `const el = ref<HTMLElement>()`
- Slot typing: `defineSlots<{ default(props: { item: T }): any }>()`

### Reactivity Primitives

```typescript
// ref: primitives, single values
const count = ref(0);
const user = ref<User | null>(null);

// reactive: objects (NEVER reassign entire object)
const state = reactive({ count: 0, name: "" });

// computed: derived state (memoized)
const doubled = computed(() => count.value * 2);
```

### Lifecycle Hooks

Use Composition API hooks: `onMounted`, `onUnmounted`, `onBeforeMount`, `onUpdated`, `watch`, `watchEffect`

## Vue Query Context

**CRITICAL**: `useQuery` and TanStack hooks MUST be called inside `<script setup>` or functions supporting injection context.

```typescript
// ✅ CORRECT
<script setup>
const query = useQuery({ queryKey: ["users"], queryFn: fetchUsers });
</script>

// ❌ WRONG: Outside setup context
const query = useQuery(...); // Error: no injection context
```

## String Conventions

```typescript
// Double quotes for strings (project standard)
const message = "Hello world";
```
