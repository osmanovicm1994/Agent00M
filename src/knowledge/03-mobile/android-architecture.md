# Android Architecture

Follow the repository's existing architecture where it is sound; do not introduce a new one for style. Use the lightest structure that fits the feature.

## Principles
- Kotlin for new code. Compose for new UI (no new XML screens unless the task or an existing XML screen requires it).
- Separate UI rendering from business rules, persistence, networking and platform integration. Unidirectional data flow; one owner per piece of state.
- No unnecessary abstraction, service locators or global mutable state. Reuse existing dependencies before adding one.

## Layers
- **UI / presentation:** Compose screens, UI state, event handling.
- **Domain (only when useful):** business models and use cases free of Android types. No one-use-case-per-function ceremony for trivial features.
- **Data:** repositories, data sources, DTOs, persistence, API clients.

## ViewModels and state
- `ViewModel` per screen with immutable UI state in a `StateFlow` (single `data class` or sealed interface for loading / content / empty / error). Collect with `collectAsStateWithLifecycle()`.
- No `Context`, `Activity`, `View` or composables inside a ViewModel. Keep one-off events (navigation, snackbar) separate from durable state, following the project's pattern.

## Dependency injection
- Use what the project has (Hilt, Koin). Otherwise constructor injection. Keep production and test wiring easy to swap; do not add a DI framework for a small change.

## Models and boundaries
- Separate API DTOs, DB entities and UI/domain models when they differ; map at the boundary. Express optionality with Kotlin nullability; never `!!` to silence an uncertain null.

## Coroutines
- Structured concurrency: `viewModelScope` / `lifecycleScope`; no `GlobalScope`, unmanaged threads or fire-and-forget work. Inject dispatchers when it helps tests. WorkManager only for deferrable, persistent background work.

## Navigation
- Use the project's navigation library. Leaf UI emits callbacks instead of holding a NavController. Pass ids, not object graphs; handle back, deep links, process recreation and missing arguments.

## Errors, security, privacy
- Model expected failures (validation, unauthorized, offline, server) and show actionable messages; never raw server text or stack traces. Do not swallow exceptions; log context without secrets.
- No hard-coded secrets; sensitive values in platform secure storage. Least-privilege permissions. Treat intents, deep links, clipboard and imported files as untrusted input.

## Workflow
1. Inspect modules, Gradle config, versions, navigation, DI and a similar existing feature.
2. Change the smallest set of files; follow local naming and error-handling conventions.
3. Add tests at the right layer, build, run targeted tests, report commands and anything not run. No unrelated refactors or upgrades.
