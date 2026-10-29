# Test Strategy: Choosing, Writing and Running Tests

## 1. Find the project's runner first
- Read `package.json` (scripts, devDependencies) and the config files (`vitest.config.*`, `jest.config.*`, `playwright.config.*`). Use the runner that is already there. Never add a second runner next to an existing one.
- If the project has no unit-test runner, adding one is its own small step: install it, add its config, add one passing sample test, add a `test` script, run it. Only then write the real tests. For Next.js, Vite and TypeScript projects use Vitest.
- Run tests through the project script (`npm test`) or the runner on one file (`npx vitest run path/to/file.test.ts`). `tsc --noEmit somefile.ts` is not a test: it ignores `tsconfig.json` and floods the output with errors from `node_modules`. Typecheck with the project script or `npx tsc --noEmit -p tsconfig.json`. If the only errors come from `node_modules`, fix the tsconfig (`skipLibCheck`, `esModuleInterop`, `lib`, `target`), not the source files.

## 2. Where tests live and what they import
- Put a test next to the code it tests (`route.test.ts` beside `route.ts`) or in the project's existing tests folder, inside the package that owns the code. In a monorepo that is `apps/web/...`, not the repository root or the package root.
- Vitest and Jest: unless the config sets `globals: true`, import what you use: `import { describe, it, expect, vi } from "vitest"`. A file without those imports fails with "describe is not defined" or "No test suite found". A path alias such as `@/` needs the same alias in the runner config.
- A test file contains at least one `it` or `test` with a real assertion. A Markdown plan, a list of test cases or a README about tests is not a test.

## 3. What to test at which level
- Unit: pure logic with no network and no database: validators (zod schemas), formatters, mappers, status transitions.
- Route handler / API: call the exported handler (`GET`, `POST`, ...) with a `Request`. Mock only the boundary (the session lookup, the database client, the storage adapter) or use a disposable test database. Cover unauthenticated (401), wrong role (403), invalid input (400/422 with the error shape), the happy path, not found, and pagination limits.
- Database-backed: use a separate test database, run migrations before the suite, create the rows each test needs and remove them afterwards. Never point tests at a development or production database and never reset a shared database.
- End-to-end (Playwright): only the few critical user journeys. See the Playwright standard.
- A test must be able to fail for a real reason. Asserting that a mock returns what you just told it to return proves nothing.

## 4. Prove it works
- After writing tests, run them and read the result: exit code 0 and a passed count above zero. "No tests found", 0 tests or a skipped suite is a failure, not a pass.
- `echo`, `ls`, `cat` and similar commands are not checks. Only a typecheck, a test run or a build proves a change. Report its real exit code and counts.
- If tests need a database or credentials that are not available, still write them, mark them skipped with the reason (`describe.skipIf(...)`), and say in the report that they were not run.
- The same failure three times: stop and report the command, the first error line, and what changed in each attempt.
