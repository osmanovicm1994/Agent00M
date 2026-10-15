# C# and .NET Backend Standards

Check the target framework and packages in the `.csproj` and follow the project's existing structure (Minimal APIs or controllers, MediatR or plain services).

## 1. API design and routing
- Minimal APIs for small services, controllers for larger ones; either way endpoints hold no business logic: bind and validate input, call an application service or handler, return the result.
- CQRS with MediatR (or similar) only when the project already uses it or the domain needs it; MediatR 13+ is commercially licensed, so check the license before adding it to a project that lacks it. Plain application services are fine.
- Validate input (FluentValidation, DataAnnotations, or endpoint filters). Return `ProblemDetails` for errors; map exceptions in one place (`IExceptionHandler` / middleware).

## 2. Entity Framework Core and data access
- Never expose entities in API responses; map to DTOs (records).
- `.AsNoTracking()` for read-only queries; project to DTOs with `Select` to avoid loading whole graphs; `Include` or split queries to prevent N+1.
- All database calls are async. Use migrations through `dotnet ef`, never edit an applied migration. Keep `DbContext` scoped; do not share it across threads.

## 3. Async and cancellation
- `async`/`await` all the way: never `.Result`, `.Wait()` or `.GetAwaiter().GetResult()` on async code (thread-pool starvation, deadlocks).
- Accept and pass a `CancellationToken` through every async I/O method.
- Use `IHttpClientFactory` (typed clients) with timeouts and Polly/resilience policies; never `new HttpClient()` per call.

## 4. Configuration and quality
- Options pattern (`IOptions<T>`) with validation on start; secrets from user-secrets or environment, never `appsettings.json` in git.
- Nullable reference types on and respected. Structured logging with `ILogger<T>` message templates, not string interpolation. Test with xUnit/NUnit and `WebApplicationFactory` for endpoints.
