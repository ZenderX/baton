---
name: vue3
description: Vue 3 coding standards with Composition API, Pinia, and TypeScript. Apply when writing or reviewing .vue files and Vue-related composables.
paths: "**/*.vue, **/composables/**/*.ts, **/stores/**/*.ts"
---

# Vue 3 Coding Standards

## Architecture

- Favor Composition API (`<script setup>`) over Options API everywhere
- Organize by feature/domain, not by type — `features/auth/` not `components/`, `stores/`, `composables/` at root
- Separate **presentational** components (receive props, emit events, no store access) from **container** components (own data fetching and store wiring)
- Extract reusable logic into composables in a `composables/` directory — one concern per composable
- Structure Pinia stores by domain with clearly defined state, getters (computed), and actions

---

## Script Setup (REQUIRED)

Always use `<script setup lang="ts">`. Never use Options API or bare `defineComponent` for new code.

```vue
<script setup lang="ts">
interface Props {
  title: string;
  count?: number;
}

const props = withDefaults(defineProps<Props>(), { count: 0 });
const emit = defineEmits<{ update: [value: number]; close: [] }>();
</script>
```

### Component Design Rules

- One concern per component — if it fetches AND renders a list AND handles pagination, split it
- PascalCase for component names; kebab-case for file names (`UserCard.vue` → `<UserCard />`)
- TypeScript props always; runtime `validator` only when the type alone is insufficient
- Favor slots and scoped slots for flexible, reusable composition over deeply nested prop chains

```vue
<!-- Flexible via scoped slot -->
<template #item="{ item }">
  <UserCard :user="item" />
</template>
```

### Component Typing

- Props: `defineProps<Interface>()` with `withDefaults()` for optionals
- Emits: `defineEmits<{ eventName: [payload: Type] }>()`
- Template refs: `const el = ref<HTMLElement>()`
- Slot typing: `defineSlots<{ default(props: { item: T }): any }>()`

---

## Reactivity

```typescript
const count = ref(0);                             // primitives and single values
const state = reactive({ count: 0 });            // objects — NEVER reassign entire object
const doubled = computed(() => count.value * 2); // derived state, memoized
```

- Prefer `computed` over `watch` when deriving state — no side effect risk
- `watch` for side effects only; use precise dependency arrays
- Return a cleanup function from `watch`, or use `onUnmounted`, to cancel timers/subscriptions
- `watch({ immediate: true })` fires on mount — verify the callback handles the initial call correctly
- Never put side effects in `computed`

### Unstable watch sources

```typescript
// ❌ Fires every render — new array reference each call
watch(() => items.map(i => i.id), handler);

// ✅ Watch the source, derive in handler
watch(items, (newItems) => { const ids = newItems.map(i => i.id); ... });
```

### Vue keys (`:key`)

Keys must be stable across renders — non-stable keys cause remount (lost focus, retriggered animations, reset state):

```typescript
// ❌ New value every render
:key="`item-${Math.random()}`"

// ✅ Stable identity from data
:key="item.id"
```

---

## Lifecycle

Use only Composition API hooks: `onMounted`, `onUnmounted`, `onBeforeMount`, `onUpdated`.
Cancel subscriptions, timers, and event listeners in `onUnmounted`.

---

## Pinia State Management

```typescript
export const useUserStore = defineStore("user", () => {
  const user = ref<User | null>(null);
  const isLoggedIn = computed(() => user.value !== null);

  async function fetchUser(id: string) {
    user.value = await api.getUser(id);
  }

  return { user, isLoggedIn, fetchUser };
});
```

- All async logic in actions — never async in `computed`
- Mutate state directly (`this.field = value`) — avoid spreading into new objects unnecessarily
- Destructure with `storeToRefs(store)` to preserve reactivity: `const { user } = storeToRefs(store)`
- Keep state normalized; avoid nested reactive objects you'd reassign entirely
- Use store plugins for cross-cutting concerns (persistence, devtools, logging)

---

## Provide / Inject

Use sparingly — only when prop drilling spans 3+ component levels.

```typescript
const userKey: InjectionKey<Ref<User>> = Symbol("user");

// Provider — wrap in ref/computed so consumers are reactive
provide(userKey, ref(currentUser));

// Consumer — always fallback or guard
const user = inject(userKey);
if (!user) throw new Error("userKey must be provided");
```

### Review heuristics

- `inject()` with no fallback returns `undefined` silently — silent failure in multi-context components
- Child `provide(key)` shadows ancestor `provide(key)` for all its descendants — verify intent when layered
- `InjectionKey<T>` type must match what `provide` passes; `| undefined` in the type when value is never undefined forces unnecessary `?.` guards everywhere
- Providing a plain (non-reactive) value means consumers won't react to changes — wrap in `ref`/`computed`

---

## Vue Router

- Use `useRoute` and `useRouter` in `<script setup>` only
- Implement route-level code splitting: `component: () => import("./views/Home.vue")`
- Protect routes with `beforeEach` or `beforeEnter` guards — never inline auth logic in components
- Route meta fields must be declared in `RouteMeta` interface — undeclared meta is `unknown`
- Truthy checks on meta (`if (route.meta.someField)`) break when `false` is valid — use `!== undefined`
- Manage query params and dynamic segments through `useRoute` — never parse `window.location` directly

---

## Data Fetching

- Use Vue Query (TanStack Query) or a composable wrapper — not raw `fetch` in `onMounted`
- Always expose loading, error, and success states explicitly; never leave UI in an ambiguous state
- Cancel in-flight requests on component unmount or when the query key changes
- Implement optimistic updates with rollbacks on failure for mutation operations
- Cache responses; use background revalidation to keep data fresh without blocking UI

### Vue Query context

**CRITICAL**: All `useQuery` and TanStack hooks must be called inside `<script setup>` or a composable that runs in an injection context.

```typescript
// ✅ Correct
const { data, isLoading } = useQuery({ queryKey: ["users"], queryFn: fetchUsers });

// ❌ Wrong — outside setup context, throws at runtime
const query = useQuery(...);
```

---

## Error Handling

```typescript
// Global — catches unhandled errors in components and composables
app.config.errorHandler = (err, instance, info) => {
  logToSentry(err);
};

// Component boundary — catch errors from child subtree
onErrorCaptured((err) => {
  showFallbackUI.value = true;
  return false; // prevent propagation
});
```

- Wrap risky async logic in `try/catch`; surface user-friendly messages, log technical details
- Use `errorCaptured` in layout/parent components to provide graceful degradation for subtrees
- Never silently swallow errors — if you catch, either recover or re-throw

---

## Forms and Validation

- Use VeeValidate or `@vueuse/form` for declarative validation — not manual `ref` + `if` chains
- Build forms with controlled `v-model` bindings
- Validate on blur or input with debouncing; avoid validating on every keystroke for expensive rules
- Extract complex multi-step forms and file upload logic into composables
- Accessible forms: every input needs a `<label>`, error messages need `role="alert"` or `aria-live`

---

## Styling

- `<style scoped>` for component-level styles to avoid unintended cascade
- CSS Modules as an alternative for fully isolated class names
- CSS custom properties for theming and design tokens — not hardcoded values
- Mobile-first responsive design with CSS Grid and Flexbox
- Accessible styles: sufficient color contrast (WCAG AA), visible focus states, never `outline: none` without a replacement

---

## Accessibility

- Use semantic HTML first (`<button>`, `<nav>`, `<main>`) — ARIA only supplements, never replaces semantics
- Manage focus explicitly for modals, drawers, and dynamically inserted content
- All interactive components must be keyboard navigable (Tab, Enter, Escape, arrow keys where applicable)
- Meaningful `alt` text for images; empty `alt=""` for decorative images
- Color contrast meets WCAG AA (4.5:1 for text, 3:1 for large text and UI components)

---

## Testing

- Unit tests with Vue Test Utils + Vitest (or Jest); focus on behavior, not implementation details
- Use `mount` for integration-level component tests; `shallowMount` only when child components are irrelevant to the test
- Mock global plugins (Vue Router, Pinia) with official test utilities: `createTestingPinia`, `RouterLinkStub`
- E2E tests with Cypress or Playwright for critical user flows
- Accessibility tests with axe-core: `cy.checkA11y()` or `@axe-core/playwright`

---

## Security

- NEVER use `v-html` with unsanitized input — XSS vector; sanitize with DOMPurify before binding
- CSP headers to mitigate XSS and injection attacks (server-side configuration)
- Validate and escape data at system boundaries (user input, external APIs)
- Use HTTPS for all API requests
- Store sensitive tokens in HTTP-only cookies, not `localStorage` or `sessionStorage`

---

## Common Patterns

| Pattern | Use case |
|---|---|
| Renderless component (via scoped slot) | Share logic without imposing markup structure |
| Compound component (provide/inject) | Shared state across tightly coupled child components (e.g., `<Tabs>` + `<Tab>`) |
| Custom directive | Cross-cutting DOM behavior (focus traps, click-outside, resize observers) |
| `<Teleport>` | Render modals/toasts at `<body>` level while keeping them co-located in source |
| Plugin (`app.use`) | Global utilities: i18n, analytics, error tracking |
| Composable factory | Parameterized composables: `useList(fetchFn)` returns paginated list logic |

---

## Scaffolding Order

When building a new Vue 3 feature or app from scratch, follow this sequence to avoid dependency-order issues:

1. Plan component/composable architecture and store domains
2. Define Pinia stores and composables (data layer first)
3. Create core UI components and layout
4. Integrate routing and navigation guards
5. Implement data fetching and state logic
6. Build forms with validation and error states
7. Add global error handling and fallback UIs
8. Add unit and E2E tests
9. Optimize performance and bundle size
10. Verify accessibility compliance

---

## Common Anti-Patterns

| Anti-pattern | Correct approach |
|---|---|
| `ref` nested inside `reactive` | Use separate `ref` values |
| Mutating props directly | Emit events; use `defineModel` for two-way binding |
| `watch` on a `computed` value | Watch the source; the computed is already reactive |
| `provide(key, plainValue)` | Wrap in `ref`/`computed` so consumers are reactive |
| `{ ...store }` destructuring | Use `storeToRefs(store)` to preserve reactivity |
| `inject()` with no fallback in multi-context component | Add fallback or explicit guard |
| Stable key includes `Math.random()` | Use a stable ID from the data |
| `v-html` without sanitization | Sanitize with DOMPurify first |
| Options API in new components | Use `<script setup lang="ts">` |
