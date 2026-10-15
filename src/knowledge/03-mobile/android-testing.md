# Android Testing

## Goals
- Test behavior and visible outcomes, not implementation. Use the lowest test level that gives real confidence, and the project's existing libraries and naming. Every bug fix gets a regression test when practical. Never add sleeps or weaken assertions to get green.

## Levels
- **Unit:** business rules, ViewModels, state transitions, validators, mappers, repository logic with fakes. Fast and deterministic.
- **Integration:** repositories with Room, serialization and API adapters (MockWebServer or controlled fakes, never live services).
- **Compose UI:** semantics, interactions, screen states, navigation.
- **Instrumented / device:** only for framework, hardware, permission or lifecycle behavior. **End-to-end:** critical journeys only.
- Do not push all coverage into UI or end-to-end tests.

## Unit tests
- Arrange-Act-Assert; names state scenario and result. Cover success, loading, empty, invalid input, failure, cancellation and boundaries.
- Test ViewModel state and emissions, not private methods. Fake repositories, no real network or delays.
- Coroutines: `kotlinx-coroutines-test` with `runTest`, one shared scheduler, injected dispatchers. Flows: collect finite flows or use Turbine if the project has it. No timing-dependent assertions.

## Compose UI tests
- Query by semantics, text, content description and role; use test tags only where those are ambiguous (centralize tag constants). Do not depend on coordinates or node hierarchy.
- Cover typing, validation, taps, scrolling, navigation, and loading / populated / empty / error states, plus disabled buttons and double-submit prevention. Synchronize on UI state, never fixed sleeps.

## Integration and device tests
- API tests: serialization, status mapping, auth failure, malformed responses, timeout, retry. Room: queries and migrations with realistic data.
- Instrumented: request permissions through the real flow, clean up state, no order dependence; separate emulator limits from real-device needs (camera, biometrics, notifications, OEM background rules). Use a small, risk-based device/API matrix.

## Data and isolation
- Each test owns its data; reset databases, preferences, files and fake servers between tests. Control date, timezone, locale and randomness. No real tokens, credentials or personal data in fixtures.

## CI and reporting
- Run unit tests on every change; instrumented suites per project policy. Use the project's Gradle tasks and report exact results. Capture redacted screenshots and logs for failed UI tests. Fix flaky tests at the root; quarantine only under an explicit policy.
