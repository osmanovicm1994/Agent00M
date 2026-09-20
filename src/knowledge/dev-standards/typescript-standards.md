# TypeScript Strictness & Type Safety

## 1. Ban the `any` Type
- The usage of `any` is strictly prohibited. If a type is genuinely dynamic, use `unknown` combined with type narrowing or generic constraints (`T`).
- Avoid type casting (`as Type`) unless interfacing with poorly typed legacy libraries; always prefer explicit type annotations and type guards.

## 2. Discriminated Unions for State Handling
- When managing multi-state logic (e.g., loading, success, error), use discriminated unions instead of optional fields:
  ```typescript
  type Result<T> = 
    | { status: 'success'; data: T }
    | { status: 'error'; error: Error };