# CI and Test Strategy for a Full-Stack App

## What runs where
- Every pull request: install (`npm ci`), typecheck, lint, unit tests, build, API e2e tests against a disposable database, Playwright smoke tests. Nightly or on main: the full Playwright suite, `npm audit`, secret scan.
- Keep the pipeline in one workflow file (GitHub Actions) with caching for dependencies and the Playwright browsers. A failing step stops the pipeline; no `continue-on-error` to hide failures.

## Test pyramid
- Unit: services, pure logic, validators, mappers (fast, no network). API e2e: `supertest` against the Nest app and a test database, covering auth, validation errors, permission failures and the happy path. UI e2e: Playwright for the few critical user journeys only (sign up, sign in, the core create/edit flow, upload).
- Each test creates its own data and cleans up; no order dependence. Never hit production services.

## Playwright against the app
- Let Playwright start the app: in `playwright.config.ts` set `webServer: { command, url, reuseExistingServer: !process.env.CI, timeout }` for the web app (and the API if needed), plus `use.baseURL`. The agent cannot keep a dev server running between commands, so this is how e2e tests run.
- Sign in once through the API in a setup project and reuse `storageState`; seed data through the API or a script, not through the UI.
- Use role, label and `data-testid` locators and web-first assertions (see `02-qa-automation/playwright-standards.md`). Traces on first retry, screenshots on failure.
- Run `npx playwright install --with-deps chromium` once in a new environment. Use `--reporter=list` locally and a JSON/HTML reporter in CI; `--repeat-each=10` to check a suspected flaky test.

## Reading failures
- Take the first failing test and its first error; open the trace or screenshot for UI failures. Fix the cause (selector, wait, data, real bug), not the symptom with a sleep or retry.
- Same error three times: stop, summarize what you tried and what the evidence says, and ask for help rather than looping.
