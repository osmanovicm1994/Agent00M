# Mobile Automation & Appium Standards

## 1. Cross-platform parity
- iOS and Android screens share the same semantic identifiers (`ScreenName.ElementName`) so one test flow and one page-object interface cover both.

## 2. Locator strategy (best to worst)
1. Accessibility id (`accessibilityIdentifier` on iOS, `content-desc` / `testTag` on Android).
2. iOS: class chain (`-ios class chain`) or predicate string (`-ios predicate string`). Avoid XPath on iOS: it is slow and fragile.
3. Android: resource id, then `UiAutomator`. XPath only as a documented last resort.
- Never locate by visible text or index when an id can be added: copy changes and reordering break those tests.

## 3. Application testability
- **iOS:** `.accessibilityIdentifier("ScreenName.ElementName")` on every interactive SwiftUI view.
- **Android Compose:** `Modifier.testTag("ScreenName.ElementName")`. A testTag reaches Appium only when the root sets `Modifier.semantics { testTagsAsResourceId = true }` (once, at the top of the screen tree); then it is found as a resource id. Without it the tag is invisible to UiAutomator2.
- Ask for the missing identifier in the app code rather than falling back to a brittle locator.

## 4. Appium 2 setup
- Drivers are installed separately (`appium driver install uiautomator2` / `xcuitest`) and selected by `appium:automationName`. Capabilities use the `appium:` prefix for vendor keys. Keep devices, app paths and server URLs in configuration, not in tests.

## 5. Stability
- Explicit waits on a condition (visible, clickable, gone) with a timeout and a message; no sleeps; implicit wait stays 0.
- Reset app state between tests (fresh install, `noReset` consciously chosen, or deep link / API setup) so tests do not depend on order.
- Handle permission and system dialogs through capabilities (`autoGrantPermissions`, `autoAcceptAlerts`) or one helper.
- On failure capture a screenshot and the page source; quit the driver in teardown.
