# C# and .NET Core Backend Standards

## 1. API Design & Routing
- Use Minimal APIs for microservices or standard Controller-based routing for large monoliths, keeping endpoints completely devoid of business logic.
- Use MediatR to implement the CQRS (Command Query Responsibility Segregation) pattern. Controllers should only dispatch commands/queries and return HTTP results.

## 2. Entity Framework Core & Data Access
- Never expose database entities directly to the API response. Always map entities to Data Transfer Objects (DTOs).
- Use `.AsNoTracking()` for all read-only queries to improve performance.
- Database calls must be strictly asynchronous.

## 3. Threading & Concurrency
- `async/await` must be used all the way down the call stack. 
- Never block async code with `.Result` or `.Wait()`, as this leads to thread-pool starvation and deadlocks.
- Use `CancellationToken` on all asynchronous I/O methods to support request cancellation.
