# Android Architecture Standards

## Purpose and scope

Use these standards when analyzing, designing, implementing, or
refactoring native Android applications. Follow the repository's
existing conventions where they are sound; do not introduce a new
architecture solely for stylistic preference.

## 1. Architecture principles

-   Prefer clear separation of concerns, unidirectional data flow,
    testability, and small cohesive components.
-   Use Kotlin for new native Android code unless the project explicitly
    requires another language.
-   Use Jetpack Compose for new UI. Do not introduce XML layouts for new
    screens unless the project or task explicitly requires XML or must
    maintain an existing XML-based screen.
-   Keep UI rendering separate from business rules, persistence,
    networking, and platform integration.
-   Avoid unnecessary abstraction, service locators, global mutable
    state, and speculative frameworks.
-   Reuse existing project architecture and dependencies before adding
    new ones.

## 2. Recommended layers

Use the lightest architecture that fits the app. For a typical feature,
separate:

-   **UI / presentation:** Compose screens, reusable UI components, UI
    state, and user-event handling.
-   **Domain (when useful):** business models, use cases, and rules that
    are independent of Android frameworks.
-   **Data:** repositories, data sources, DTOs, persistence, and API
    clients.

Do not create a domain layer or one-use-case-per-function structure for
trivial features without a concrete benefit.

## 3. ViewModels and UI state

-   Use `ViewModel` for screen-level state and coordination when state
    must survive configuration changes or when the screen has meaningful
    logic.
-   Expose immutable UI state, commonly with `StateFlow` and a data
    class such as `ScreenUiState`.
-   Keep state updates predictable and perform them through a single
    state owner.
-   Collect flows in Compose with lifecycle-aware APIs such as
    `collectAsStateWithLifecycle()`.
-   Do not place Android `Context`, `Activity`, `View`, or composable
    functions inside a ViewModel.
-   Avoid putting long-lived application logic in an Activity or
    composable.
-   Keep transient UI events distinct from durable screen state. Choose
    event handling based on delivery guarantees and the project's
    established pattern.

## 4. Dependency injection

-   Follow the dependency injection framework already in the project
    (for example, Hilt or Koin).
-   If no framework exists, use constructor injection and the simplest
    composition mechanism appropriate to the app.
-   Prefer dependencies passed explicitly over hidden global access.
-   Do not add a DI framework for a small isolated change unless there
    is a clear maintainability benefit.
-   Keep production and test dependency wiring easy to replace.

## 5. Models and boundaries

-   Separate API DTOs, database entities, and UI/domain models when
    their responsibilities or lifecycles differ.
-   Map data at boundaries; avoid leaking serialization or
    database-specific types through the UI.
-   Use Kotlin nullability to express optional data explicitly. Do not
    use `!!` to silence uncertain nulls.
-   Represent loading, success, empty, and error states explicitly
    rather than using ambiguous nullable fields or magic strings.
-   Use sealed types or similarly clear models when a state has mutually
    exclusive variants.

## 6. Coroutines and concurrency

-   Use structured concurrency. Tie coroutine work to a suitable
    lifecycle or scope.
-   Use `viewModelScope` for screen-related work owned by a ViewModel
    and `lifecycleScope` for lifecycle-owned UI work.
-   Avoid `GlobalScope`, unmanaged threads, blocking calls on the main
    thread, and fire-and-forget work without an owner.
-   Make dispatcher dependencies injectable when they materially improve
    testability.
-   Use WorkManager for deferrable, persistent background work; do not
    use it as a substitute for immediate UI coroutine work.

## 7. Navigation

-   Follow the navigation library and patterns already adopted by the
    project.
-   Keep navigation decisions outside reusable leaf UI components where
    practical; emit callbacks or navigation events instead.
-   Pass stable identifiers or minimal arguments between destinations
    rather than entire large object graphs.
-   Handle back navigation, deep links, process recreation, and
    invalid/missing arguments deliberately.
-   Avoid duplicating navigation state across multiple owners.

## 8. Error handling and observability

-   Model expected failures explicitly and present actionable,
    user-appropriate feedback.
-   Do not swallow exceptions silently. Log useful diagnostic context
    without secrets or personal data.
-   Avoid exposing raw server messages, stack traces, or internal
    implementation details to users.
-   Distinguish recoverable errors from authentication, validation,
    connectivity, and unexpected failures.
-   Keep analytics and logging calls out of core business rules where
    possible; use interfaces when needed.

## 9. Security and privacy

-   Never hard-code API secrets, passwords, private keys, or production
    credentials.
-   Store sensitive local values using appropriate platform security
    facilities; do not treat ordinary preferences as a secure vault.
-   Request only the permissions needed for the feature and explain
    permission-dependent behavior.
-   Avoid logging access tokens, session identifiers, personal data, or
    sensitive request/response bodies.
-   Use HTTPS and follow the project's authentication and token-refresh
    strategy.
-   Treat external intents, deep links, clipboard data, and imported
    files as untrusted input.

## 10. Implementation workflow

1.  Inspect module structure, Gradle configuration, dependency versions,
    navigation, DI, and existing feature patterns.
2.  Identify the smallest set of files and layers that need to change.
3.  Follow local naming, package, formatting, and error-handling
    conventions.
4.  Add or update tests at the appropriate layer.
5.  Build and run targeted tests; report commands and any checks that
    could not be run.
6.  Avoid unrelated refactors and dependency upgrades in a feature
    change.

## 11. Architecture review checklist

-   [ ] Responsibilities are separated without unnecessary layers.
-   [ ] State has a clear owner and flows in one direction.
-   [ ] Dependencies are explicit and testable.
-   [ ] Coroutines have appropriate owners and cancellation behavior.
-   [ ] UI does not depend directly on API/database implementation
    details.
-   [ ] Errors and loading/empty states are modeled deliberately.
-   [ ] Sensitive values are not hard-coded or logged.
-   [ ] Tests cover meaningful business and state behavior.
