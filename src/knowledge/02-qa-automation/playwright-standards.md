# Web Automation & Playwright Standards

## 1. Page Object Model (POM)
- UI tests must never contain raw locators or inline actions. All page interactions must be encapsulated in Page classes.
- **Action-Locator Split:** Strictly separate locators from actions. Define locators as private properties at the top of the Page class, and use them within public action methods. Never define a locator inline inside a click or fill action.

## 2. Custom Test Fixtures
- Utilize custom Playwright test fixtures to manage state and setup/teardown. All custom fixtures MUST be strictly typed using TypeScript interfaces and properly annotated with JSDoc to ensure intellisense in the test files.

## 3. Testability in Frontend Code
- All interactive React/Next.js elements (buttons, inputs, links) must include strict `data-testid` attributes to support deterministic End-to-End testing via Playwright.
