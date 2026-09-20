# Architectural Patterns & Modular Structure

## 1. Separation of Concerns (The Onion / Layered Approach)
- **Controllers (`.controller.ts`):** Handle HTTP transport boundaries, request mapping, status codes, and input validation decorators. No business logic should reside here.
- **Services (`.service.ts`):** Contain pure business rules, transaction orchestration, and core domain logic. They must be framework-agnostic where possible.
- **Repositories / Data Access:** Abstract database queries away from services to keep business logic testable.

## 2. NestJS Module Encapsulation
- Every feature domain must be encapsulated in its own self-contained module (e.g., `UsersModule`, `OrdersModule`).
- Use explicit `imports`, `controllers`, `providers`, and `exports` arrays. Never leak internal services across module boundaries without explicit exporting.
- Avoid circular dependencies between modules. If a circular dependency occurs, refactor shared logic into a common utility or use NestJS `forwardRef()` only as an absolute last resort.

## 3. Dependency Injection & Instantiation
- Always leverage NestJS constructor-based dependency injection. 
- Avoid global state or singleton utility classes with side effects; favor stateless service providers.