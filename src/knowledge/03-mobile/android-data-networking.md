# Android Data and Networking

## Boundaries
- No network or persistence in composables. Access data through repositories (or the project's data-access abstraction); do not add layers that only forward calls.
- Keep DTOs, entities and UI/domain models separate when they differ; map at the boundary.

## HTTP
- Reuse the project's stack (Retrofit/OkHttp with Kotlin serialization or Moshi). Centralize base URL, interceptors, serialization and timeouts; set connect/read/write timeouts deliberately.
- Typed request/response models, not loose maps. HTTPS only; never disable certificate validation or install a permissive trust manager. Environment URLs come from build config; no secrets in the repo.

## Coroutines and Flow
- `suspend` for one-shot work, `Flow` for streams. Structured scopes; let cancellation propagate and never catch `CancellationException` or broad `Throwable`.
- `Dispatchers.IO` for blocking I/O, `Default` for CPU work, injected when tests need control. No unnecessary `withContext` around already-suspending APIs.

## Errors
- Distinguish validation, unauthorized, rate limit, server, timeout and offline. Convert low-level exceptions to stable results at a boundary; keep the cause for logs and show safe messages to users.
- Handle empty successful responses and malformed payloads deliberately.

## Auth and security
- Follow the app's token/refresh strategy. Tokens and credentials never in source, logs, analytics, crash reports or URLs. Secure storage (Keystore / EncryptedSharedPreferences / DataStore with encryption), not plain preferences. Do not log full request/response bodies in production. Certificate pinning only when the threat model justifies it.

## Retries, caching, offline
- Retry only safe or idempotent operations, bounded, with backoff; do not retry auth or validation failures.
- Cache only with defined freshness and invalidation. Room for structured local data, DataStore for small settings. Decide offline behavior per feature (stale data, queued writes, offline state).

## Pagination, persistence, background work
- Use the project's pagination (Paging 3 for large lists); never load unbounded data into memory; handle duplicates, refresh and retry states.
- Room migrations are explicit and tested; no destructive migration in production unless data loss is acceptable. Define deletion on sign-out.
- WorkManager for deferrable, guaranteed work with constraints, backoff and unique work; not for immediate UI work.

## Review checklist
- UI decoupled from data implementations; boundaries mapped; main thread free; cancellation and errors correct; retries bounded; no secrets logged; caching and migrations deliberate; repository behavior unit-tested.
