# Architecture & Clean Layering

Follow the architecture the project already has. Apply the layering below to new code and to projects that have none; do not add layers, interfaces or abstractions to a small project that works without them.

## 1. Separation of concerns
- **Domain:** business entities and rules. No dependency on frameworks, databases or HTTP.
- **Application / use cases:** orchestrate business rules through injected interfaces, never concrete implementations.
- **Infrastructure:** database, external API clients, file system.
- **Delivery:** HTTP controllers, resolvers, UI view models. Only input validation, mapping and routing.
- Dependencies point inward: delivery and infrastructure depend on the domain, never the reverse.

## 2. Dependency injection
- No `new Service()` inside business logic. Inject through constructors (C#, Swift, Kotlin, NestJS, FastAPI `Depends`).
- Depend on interfaces / protocols so tests can substitute them. Create one only when there is a second implementation or a test needs it.

## 3. State and mutation
- Prefer immutability: readonly fields, `let` / `val`, records and data classes.
- Pure functions for data transformations; keep side effects at the edges (I/O, time, randomness passed in).

## 4. Boundaries
- Validate and map data where it enters the system (DTO, schema); inside, work with trusted typed values.
- One owner per piece of state. Do not let two modules write the same data.
- Avoid circular dependencies between modules; if two need each other, extract the shared part.
