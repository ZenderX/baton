---
description: TypeScript and Vue 3 coding standards
applyTo: "**/*.{ts,tsx,vue}"
---

# TYPESCRIPT & VUE 3 CODING STANDARDS

Language-specific rules for TypeScript and Vue 3. Architecture, state management, and project patterns in `project.instructions.md`.

---

## TYPESCRIPT STRICT MODE
```typescript
// ✅ ENFORCE
- NO `any` types
- NO non-null assertions (`!`)
- NO `as unknown` casting
- NO unused parameters (prefix with `_` to ignore)
- Use `import type` for type-only imports
- Define interfaces for component props and store state
- Type all error handling with proper annotations

// ❌ FORBIDDEN
const data: any = fetchData();           // Use proper interface
const value = obj!.prop;                 // Handle null explicitly
const user = data as unknown as User;    // Use type guards
```

---

## VUE 3 COMPOSITION API

### Script Setup (REQUIRED)
```vue
<script setup lang="ts">
// ✅ CORRECT: Always use <script setup>
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
```typescript
// Props: defineProps<Interface>() with withDefaults() for optionals
// Emits: defineEmits<{ eventName: [payload: Type] }>()
// Template refs: const el = ref<HTMLElement>()
// Slot typing: defineSlots<{ default(props: { item: T }): any }>()
```

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

---

## VUE QUERY CONTEXT
**CRITICAL**: `useQuery` and TanStack hooks MUST be called inside `<script setup>` or functions supporting injection context.

```typescript
// ✅ CORRECT
<script setup>
const query = useQuery({ queryKey: ["users"], queryFn: fetchUsers });
</script>

// ❌ WRONG: Outside setup context
const query = useQuery(...); // Error: no injection context
```

---

## NAMING CONVENTIONS
```typescript
// Components: PascalCase
VButton.vue, AuthForm.vue, DashboardLayout.vue

// Composables: camelCase with "use" prefix
useAuth.ts, useTheme.ts, useApi.ts

// Stores: camelCase
auth.ts, theme.ts, uiState.ts

// Utils/Services: camelCase
authHelpers.ts, LoggerService.ts, apiClient.ts

// Types/Interfaces: PascalCase
User, ApiResponse, ApiResult

// Constants: SCREAMING_SNAKE_CASE or camelCase
API_BASE_URL, maxRetries

// Route paths: kebab-case
/dashboard, /auth-callback, /user-profile
```

---

## STRING CONVENTIONS
```typescript
// Double quotes for strings (project standard)
const message = "Hello world";

// Template literals for interpolation
const greeting = `Hello ${name}`;

// Template literals or .join() for building strings
const path = ["api", "v1", "users"].join("/");
const url = `${baseUrl}/api/${endpoint}`;

// ❌ AVOID: Concatenation
const bad = "api" + "/" + "v1" + "/" + "users";
```

---

## DOCUMENTATION REQUIREMENTS

### File Headers (MANDATORY)
```typescript
/**
 * @fileoverview Composable for managing authentication state and session lifecycle.
 * Provides reactive auth state, sign-in/sign-out methods, and session refresh.
 */
```

### Function Documentation (MANDATORY)
```typescript
/**
 * Fetches user data from the API.
 * @param userId - The unique identifier for the user
 * @param options - Optional query configuration
 * @returns Promise resolving to user data or null if not found
 * @throws {Error} When network request fails or user is unauthorized
 */
async function fetchUser(
  userId: string,
  options?: QueryOptions
): Promise<User | null> {
  // Implementation
}
```

### Inline Comments
```typescript
// Clarify non-obvious logic, algorithm choices, workarounds
// Comment external API calls with inputs/outputs/purpose

// Debounce to prevent excessive validation calls (30s window)
const debouncedValidate = debounce(validateSession, 30000);
```

---

## ERROR HANDLING & TYPE VALIDATION
```typescript
// Type-safe error handling with proper annotations
type Result<T> = { success: true; data: T } | { success: false; error: string };

async function fetchData(): Promise<Result<User>> {
  try {
    const data = await api.getUser();
    return { success: true, data };
  } catch (error) {
    // Type guard for error handling
    const message = error instanceof Error ? error.message : "Unknown error";
    return { success: false, error: message };
  }
}

// Handle all error states explicitly
if (!result.success) {
  logger.error("Failed to fetch user", { error: result.error });
  emit("error", result.error);
  return;
}
```

---

## CODE QUALITY ENFORCEMENT

### Type Completeness
```typescript
// ✅ Full typing, no loose inference
interface ComponentProps {
  items: Array<{ id: string; name: string }>;
  onSelect: (id: string) => void;
}

// ❌ Avoid loose typing
const props: any = {};
const data = [];  // Type inference too vague
```

### Dead Code Removal
- Remove unused imports (ESLint enforces)
- Remove unused variables/functions
- Remove deprecated features
- Remove commented-out code blocks

### Clean Code Principles
```typescript
// Avoid deep nesting (max 3 levels)
// Extract complex conditions to named booleans
const isEligible = user.verified && user.age >= 18 && !user.banned;
if (isEligible) { /* ... */ }

// Prefer early returns over nested if/else
if (!user) return null;
if (!user.verified) return null;
return user.profile;

// Use modern features appropriately
const { name, email } = user;  // Destructuring
const users = await Promise.all(ids.map(fetchUser));  // Array methods
```

---

## COMPONENT TYPING STANDARDS

### Props & Emits
```typescript
interface ButtonProps {
  variant?: "primary" | "secondary" | "danger";
  loading?: boolean;
  disabled?: boolean;
}

const props = withDefaults(defineProps<ButtonProps>(), {
  variant: "primary",
  loading: false,
  disabled: false
});

const emit = defineEmits<{
  click: [event: MouseEvent];
  submit: [data: FormData];
}>();
```

### Slots
```typescript
defineSlots<{
  default(props: { item: User }): any;
  header(): any;
  footer(props: { total: number }): any;
}>();
```

### Template Refs
```typescript
const inputRef = ref<HTMLInputElement>();
const componentRef = ref<InstanceType<typeof VButton>>();

onMounted(() => {
  inputRef.value?.focus();
});
```

---

## TEST TYPING
```typescript
// Type test data and fixtures
interface MockUser {
  id: string;
  name: string;
  email: string;
}

const mockUser: MockUser = {
  id: "123",
  name: "Test User",
  email: "test@example.com"
};

// Type mocks properly
const mockFetchUser = vi.fn<[string], Promise<User>>();

// Type-safe assertions
expect<User>(result).toMatchObject({ id: "123" });
```

---

## LINTING COMPLIANCE
- Respect existing ESLint configuration (`eslint.config.js`)
- Fix all warnings before commit (warnings treated as errors)
- Run `yarn lint` before PR
- Use `yarn lint --fix` for auto-fixable issues

---

## ANTI-PATTERNS (AVOID)
```typescript
// ❌ Options API (use Composition API)
export default { data() {}, methods: {} }

// ❌ Mixins (use composables)
import mixin from "./mixin";

// ❌ any types
const data: any = fetchData();

// ❌ Non-null assertions
const value = user!.profile!.name;

// ❌ Prop drilling >2 levels (use store/composable)
<Parent :data="data">
  <Child :data="data">
    <GrandChild :data="data">  <!-- Too deep -->
```