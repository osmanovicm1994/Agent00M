# Universal Architecture & Clean Layering

## 1. Clean Architecture & Separation of Concerns
- **Domain Layer:** Core business entities and interfaces. Must have ZERO dependencies on frameworks, databases, or HTTP contexts.
- **Use Case / Application Layer:** Orchestrates business rules. Relies on injected repository interfaces, never concrete implementations.
- **Infrastructure Layer:** Concrete database implementations, external API clients, and file system access.
- **Presentation / Delivery Layer:** HTTP Controllers, GraphQL resolvers, or UI ViewModels. Responsible ONLY for input validation and routing.

## 2. Dependency Injection (DI)
- Hardcoded dependencies (`new Service()`) inside business logic are strictly prohibited.
- Inject dependencies via constructors across all object-oriented languages (C#, Swift, Kotlin).
- Rely on interfaces/protocols, not concrete classes, to allow for mocking during tests.

## 3. State & Mutation
- Favor immutability. Use readonly fields, `let` (Swift), `val` (Kotlin), and immutable records/data classes where possible.
- Pure functions should be used for data transformations to eliminate side effects.
