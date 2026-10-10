# Android Data and Networking Standards

## 1. Responsibilities and boundaries

-   Keep network and persistence code out of composables and UI
    components.
-   Access data through repositories or the project's established
    data-access abstraction.
-   Use the smallest appropriate structure; do not add multiple layers
    that only forward calls without adding value.
-   Keep API DTOs, database entities, and UI/domain models separate when
    their fields or responsibilities differ.
-   Map external data at the boundary and keep transport-specific
    details out of UI code.

## 2. HTTP clients and APIs

-   Reuse the project's existing HTTP client and serialization stack
    (for example, Retrofit/OkHttp and Kotlin serialization or Moshi)
    unless there is a concrete reason to change.
-   Centralize base URLs, client configuration, serialization,
    interceptors, and timeouts.
-   Use typed request/response models rather than loosely structured
    maps or unvalidated JSON.
-   Define connect, read, and write timeouts intentionally. Avoid
    infinite or excessively long waits.
-   Use HTTPS in production. Do not disable certificate validation or
    install permissive trust managers.
-   Keep environment-specific endpoints in build configuration or
    approved configuration files; never commit secrets.
-   Avoid making a network request from a composable body or from a UI
    render callback.

## 3. Coroutines and Flow

-   Use `suspend` functions for one-shot asynchronous operations and
    `Flow` for streams or observable data where appropriate.
-   Keep operations within structured coroutine scopes and allow
    cancellation to propagate.
-   Use an injected dispatcher for CPU-heavy or blocking work when
    necessary; do not block the main thread.
-   Prefer `Dispatchers.IO` for blocking I/O and `Dispatchers.Default`
    for CPU-intensive work when using dispatcher switching explicitly.
-   Do not wrap already-suspending APIs in unnecessary `withContext`
    blocks.
-   Define how cancellation, retries, and timeouts interact;
    cancellation should not be converted into a normal error
    accidentally.

## 4. Error modeling

-   Distinguish expected outcomes such as validation errors,
    unauthorized access, rate limits, server failures, timeouts, and
    offline conditions.
-   Convert low-level exceptions into stable domain/data results at a
    suitable boundary.
-   Preserve useful diagnostic causes for logs and debugging, while
    exposing safe, actionable messages to users.
-   Do not catch `Throwable` broadly or swallow exceptions. Re-throw
    cancellation exceptions.
-   Avoid using exceptions as ordinary control flow when a typed result
    is clearer.
-   Handle empty successful responses and malformed payloads
    deliberately.

## 5. Authentication and security

-   Follow the app's existing authentication and refresh-token strategy.
-   Keep tokens and credentials out of source control, logs, analytics,
    crash reports, and UI state dumps.
-   Store sensitive credentials using appropriate Android security APIs
    and platform-backed encrypted storage where suitable; do not assume
    ordinary preferences are secure.
-   Use least-privilege permissions and avoid unnecessary collection or
    retention of personal data.
-   Avoid logging full request/response bodies in production, especially
    for authenticated endpoints.
-   Do not put secrets in query parameters, URLs, screenshots, or
    exception messages.
-   Consider certificate pinning only when justified by the threat model
    and maintainability requirements; never add it casually.

## 6. Retries, caching, and offline behavior

-   Retry only operations that are safe to retry, or use an idempotency
    strategy for mutations.
-   Use bounded retries with backoff for transient failures; do not
    retry authentication or validation failures indefinitely.
-   Avoid retrying non-idempotent requests blindly.
-   Cache data only when product behavior and freshness requirements are
    defined.
-   Provide an offline or stale-data experience when required by the
    feature.
-   Use Room for structured local relational data when appropriate; use
    DataStore for small preference-like settings.
-   Do not use a database as a substitute for a cache policy without
    defining invalidation and synchronization behavior.

## 7. Pagination and large payloads

-   Use the project's established pagination approach; use Paging 3 when
    it fits large, incrementally loaded datasets.
-   Avoid loading unbounded datasets into memory.
-   Handle duplicate items, page boundaries, refresh, and retry states
    deliberately.
-   Stream or process large files where practical rather than loading
    them fully into memory.
-   Define upload/download progress, cancellation, and failure recovery
    for long-running transfers.

## 8. Persistence and migrations

-   Choose storage based on the data: DataStore for preferences, Room
    for structured records, files for file content, and platform secure
    storage for credentials.
-   Do not store passwords, access tokens, or other secrets in
    plain-text files or ordinary preferences.
-   Use explicit database migrations and test them; do not rely on
    destructive migration in production unless data loss is explicitly
    acceptable.
-   Make data ownership and deletion behavior clear, including sign-out
    and account removal.
-   Keep schema changes backward-compatible where required by the app's
    upgrade path.

## 9. Background work

-   Use WorkManager for deferrable, guaranteed background tasks that
    should survive process restarts.
-   Define constraints, retry policy, backoff, unique work behavior, and
    cancellation.
-   Do not use WorkManager for work that must happen immediately in
    response to a visible interaction.
-   Respect Android background execution limits and battery/network
    constraints.

## 10. Data/network review checklist

-   [ ] UI is decoupled from network and persistence implementations.
-   [ ] DTOs and external input are validated and mapped at boundaries.
-   [ ] Main-thread blocking is avoided.
-   [ ] Cancellation and errors are handled correctly.
-   [ ] Retries are bounded and safe for the operation.
-   [ ] Secrets and personal data are not logged or committed.
-   [ ] Caching, offline behavior, and migrations are deliberate.
-   [ ] Network and repository behavior has unit tests.
