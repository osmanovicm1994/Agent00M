# iOS Testing

## Framework and conventions
- Use the framework the project already uses: XCTest, or Swift Testing (`import Testing`, `@Test`, `#expect`) where the project has adopted it. Do not mix styles in one file and do not migrate existing tests unasked.
- Test target mirrors the app structure. Name tests by behavior: `test_save_whenOffline_showsRetryError`.
- Tests are deterministic: no real network, no real clock, no shared mutable state, no fixed sleeps. Inject `URLProtocol` stubs, fake repositories and a controllable clock/`Date` provider.

## What to test first
1. Domain logic and pure functions.
2. ViewModels: state transitions for loading -> content, empty, error, retry, and user actions. With async code use `async` test methods and `await`; mark ViewModel tests `@MainActor`.
3. Repositories/API clients with stubbed responses: success, decoding failure, 401, 5xx, timeout, offline.
4. UI flows (XCUITest) for the critical user journeys only.

## Test doubles
- Depend on protocols so a fake or stub can replace the real type. Hand-written fakes are preferred over heavy mocking frameworks; use a library only if the project already has one.
- Never hit production services. UI tests launch the app with launch arguments/environment (`app.launchArguments = ["-UITests"]`) that switch to stub data.

## XCUITest
- Find elements by `accessibilityIdentifier`, not by visible text (text changes with language and copy). Add identifiers to the app code when missing.
- Wait with `waitForExistence(timeout:)` or expectations; never `sleep`. Reset app state per test (`app.launch()` fresh, clean data).
- Cover: happy path, validation error, empty state, offline/error state, permission prompts handled via `addUIInterruptionMonitor`.
- Keep each UI test independent and short; one scenario per test.

## Running
- `xcodebuild test -scheme <Scheme> -destination 'platform=iOS Simulator,name=<existing simulator>'` (list valid ones with `xcrun simctl list devices available`). Add `-only-testing:<Target>/<Class>/<test>` to run a subset. For packages: `swift test`.
- Read the failure output; fix the cause. Do not weaken, skip or delete a test to make it pass. Report counts of passed/failed tests exactly as printed.
