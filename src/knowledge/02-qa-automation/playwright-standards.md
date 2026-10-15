# Web Automation & Playwright Standards

Follow the project's existing Playwright setup (config, fixtures, naming) first.

## 1. Page Object Model
- Tests contain intent only; Page classes hold locators and actions. Locators are private properties at the top of the class, used inside public action methods, never inline in a click or fill.
- Page methods return the next page object or a value; assertions stay in the test.

## 2. Locators
- Prefer user-facing locators: `getByRole` (with name), `getByLabel`, `getByPlaceholder`, `getByText`, then `getByTestId` (`data-testid`) for elements without a stable role or label. CSS and XPath only as a last resort. Scope with `locator.filter()` instead of index-based picks (`nth`).

## 3. Assertions and waiting
- Use web-first assertions (`await expect(locator).toBeVisible()`, `toHaveText`, `toHaveURL`): they retry until the timeout. No `waitForTimeout`, no manual sleeps, no assertion on a value read once (`expect(await locator.textContent())`).
- Wait for the user-visible result of an action, or for a specific response (`page.waitForResponse`), not for the network to go idle.

## 4. Isolation and fixtures
- Each test is independent and runs in its own browser context. Create state through the API or a fixture, not through earlier tests.
- Log in once per worker or project and reuse `storageState`; do not log in through the UI in every test.
- Custom fixtures are typed with TypeScript interfaces (`test.extend<MyFixtures>()`) and hold setup and teardown. Mock third-party or unstable services with `page.route`.

## 5. Config and reliability
- Use `baseURL`, a sensible `timeout` and `expect.timeout` in `playwright.config`; `trace: 'on-first-retry'`, screenshots and video on failure; `retries` only in CI (a retry that is needed to pass is a flaky test to fix, not a feature).
- Tag suites (`@smoke`, `@regression`) and run them through `--grep` or projects.

## 6. Testability in frontend code
- Interactive React/Next elements get a stable `data-testid` when role and label are not enough. Ids do not depend on language or styling.
