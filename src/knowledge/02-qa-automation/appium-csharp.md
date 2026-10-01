# Appium with C# / NUnit Standards

## 1. Driver & Capabilities
- Use the `Appium.WebDriver` NuGet package. From 5.x locators live on `AppiumBy` (older 4.x used `MobileBy`); check which the project references before writing code.
- Create `AndroidDriver` / `IOSDriver` from an `AppiumOptions` object built from configuration (json / env), never hard-coded device names, UDIDs, or app paths inside tests.
- One driver per test (or per fixture when tests are independent). Always quit the driver in `[TearDown]` / `[OneTimeTearDown]`, even when the test fails.

## 2. Locators
- Prefer accessibility ids: `AppiumBy.AccessibilityId("Screen.Element")` maps to `accessibilityIdentifier` on iOS and `content-desc` / `testTag` on Android.
- iOS fallback: `AppiumBy.IosClassChain(...)` or `AppiumBy.IosNSPredicate(...)`. Do NOT use XPath on iOS.
- Android fallback: `AppiumBy.Id(...)` (resource-id) or `AppiumBy.AndroidUIAutomator(...)`. XPath only as a documented last resort.
- Keep locator strings in one place (the Page class), never inline in tests.

## 3. Page Object Model
- Tests contain intent only (`loginPage.SignIn(user)`); Page classes contain locators and actions. Locators are `private readonly` fields at the top of the class.
- Cross-platform: define an interface per screen (`ILoginPage`) with `AndroidLoginPage` / `IosLoginPage` implementations created by a factory, so test code is shared.
- Page methods return the next page object (fluent navigation) or a value; they never assert. Assertions live in tests.

## 4. Waiting & Stability
- Never use `Thread.Sleep`. Use explicit waits (`WebDriverWait` with a timeout and a condition such as element displayed / clickable).
- Keep the implicit wait at zero; mixing implicit and explicit waits gives unpredictable timeouts.
- Wrap waits in helper methods (`WaitForVisible(by)`, `WaitForGone(by)`) with a clear timeout message so failures explain themselves.
- Handle system dialogs (permissions, notifications) through capabilities (`autoGrantPermissions` on Android) or a dedicated helper, not ad-hoc taps in tests.

## 5. NUnit Conventions
- Arrange / Act / Assert, one behavior per test, descriptive names (`SignIn_WithInvalidPassword_ShowsError`).
- Use `[Category]` for suites (smoke / regression) and `[TestCase]` / `[TestCaseSource]` for data-driven cases.
- On failure, capture a screenshot and page source in `[TearDown]` when `TestContext.CurrentContext.Result.Outcome.Status` is failed, and attach them with `TestContext.AddTestAttachment`.
- Tests must be independent and order-agnostic: create the state they need (API / deep link) instead of relying on a previous test.
