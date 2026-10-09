# Android Testing Standards

## 1. Testing goals

-   Test behavior and user-visible outcomes, not implementation details.
-   Prefer fast, deterministic tests and use the lowest test level that
    gives meaningful confidence.
-   Follow the project's existing test libraries and naming conventions
    before introducing new dependencies.
-   Every bug fix should include a regression test when practical.
-   Do not make tests pass by adding arbitrary sleeps or weakening
    meaningful assertions.

## 2. Test pyramid

Use a balanced mix of:

-   **Unit tests:** business rules, ViewModels, state transitions,
    validators, mappers, and repository logic with dependencies replaced
    by fakes or mocks.
-   **Integration tests:** real interactions between components such as
    repositories, Room, serialization, and API adapters.
-   **Compose UI tests:** semantics, interactions, screen states, and
    navigation behavior.
-   **Instrumented/device tests:** behavior that requires Android
    framework, hardware, permissions, lifecycle, or real-device
    validation.
-   **End-to-end tests:** critical journeys only; keep them focused
    because they are slower and more environment-sensitive.

Do not push all coverage into UI or end-to-end tests.

## 3. Unit tests

-   Follow Arrange--Act--Assert or Given--When--Then consistently.
-   Use descriptive test names that state the scenario and expected
    result.
-   Cover success, loading, empty, invalid input, failure, cancellation,
    and boundary cases where relevant.
-   Use deterministic fake repositories and test data.
-   Test ViewModel state and emitted results rather than private
    methods.
-   For coroutine tests, use `kotlinx-coroutines-test`, `runTest`, and a
    shared test scheduler where needed.
-   Avoid real network calls, real delays, and reliance on the
    developer's local environment.
-   Verify important interactions only when they are part of the
    behavior contract.

## 4. Flow and coroutine testing

-   Use `runTest` for coroutine tests and control virtual time where
    appropriate.
-   Inject dispatchers when tests need deterministic scheduling.
-   Collect finite flows with appropriate terminal operators; use
    Turbine if already adopted by the project.
-   Test cancellation and error propagation where they affect
    user-visible behavior.
-   Avoid flaky assertions that depend on thread timing or arbitrary
    polling.

## 5. Compose UI tests

-   Use Compose testing APIs and query UI through semantics, text,
    content descriptions, roles, and test tags when necessary.
-   Prefer user-facing semantics over brittle internal layout
    assumptions.
-   Add test tags only where semantic selectors are insufficient or
    ambiguous; centralize tag constants if that is the project
    convention.
-   Test important actions: typing, validation, button taps, scrolling,
    selection, navigation, and accessibility-relevant labels.
-   Cover loading, populated, empty, and error states for complex
    screens.
-   Verify disabled/enabled behavior and prevention of duplicate
    submissions.
-   Do not use fixed sleeps. Wait for observable UI state or use the
    test framework's synchronization.
-   Keep tests independent of exact screen coordinates and
    implementation-specific node hierarchy where possible.

## 6. Integration and API tests

-   Use mock web servers or controlled fakes for API tests; do not
    depend on unstable external services in normal CI.
-   Test serialization, status-code mapping, authentication failures,
    malformed responses, timeouts, and retry behavior where relevant.
-   Verify repository cache and source-of-truth behavior when local and
    remote data interact.
-   Test Room queries and migrations with realistic schemas and
    representative data.
-   Avoid embedding real tokens, credentials, or personal data in test
    fixtures.

## 7. Device and instrumented tests

-   Use instrumented tests only when framework or device behavior is
    necessary.
-   Keep tests compatible with supported API levels and device
    configurations.
-   Request runtime permissions through the actual flow when testing
    permission-dependent features.
-   Clean up state created by a test and avoid relying on execution
    order.
-   Separate emulator limitations from real-device requirements,
    especially for camera, biometrics, notifications, background
    restrictions, and OEM behavior.
-   Use a small, intentional device/API matrix rather than testing every
    combination without risk-based justification.

## 8. Test data and isolation

-   Give each test its own data and avoid shared mutable fixtures.
-   Reset databases, preferences, files, and fake server state between
    tests.
-   Avoid depending on the current date, timezone, locale, network, or
    random values unless explicitly controlled.
-   Keep test fixtures minimal, readable, and representative.
-   Do not place production secrets or real user information in test
    assets.

## 9. CI and reporting

-   Run unit tests on every relevant change and run instrumented/UI
    suites according to CI cost and project policy.
-   Use the project's Gradle test tasks and report failures with enough
    context to reproduce them.
-   Capture screenshots, logs, and relevant diagnostics for failed
    UI/device tests when supported, while ensuring sensitive data is
    redacted.
-   Do not silently ignore flaky tests. Track, isolate, and fix the root
    cause; quarantine only under an explicit policy.
-   Keep tests repeatable locally and in CI.

## 10. Testing review checklist

-   [ ] Tests assert behavior, not private implementation.
-   [ ] Important success and failure paths are covered.
-   [ ] Coroutines and flows are deterministic.
-   [ ] Compose tests use semantics instead of coordinates where
    possible.
-   [ ] No arbitrary sleeps or uncontrolled external dependencies.
-   [ ] Tests clean up state and run independently.
-   [ ] CI reports failures and useful diagnostics.
