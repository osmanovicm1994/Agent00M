# Plan template: a whole data app in verifiable slices

For the Project Manager. A plan of 6 to 9 tasks; every task ends with checks a command or a file can prove. Names of folders come from the request first (see layout rule), else from the default layout.

| # | Role | Task | Proof (acceptance) |
|---|------|------|--------------------|
| 1 | infra | Scaffold the app with the standard command, install ALL planned dependencies in one command, add scripts `typecheck`, `test`, `build`; remove the starter content (page, title, demo images) | `npm ls --depth=0` exits 0; `npm run build` exits 0; no file contains "To get started by editing" |
| 2 | db | Prisma schema (User with role, the records with ONE owner column, indexes), `prisma.config.ts`, client file, seed from env variables | `prisma validate` and `prisma generate` exit 0; migration applied or reported "not applied: no database reachable" |
| 3 | api | Auth (login, session with id and role), guards, `ownerFilter`, zod schemas | login test: wrong password refused, right one signed in |
| 4 | api | Resource route handlers (list, create, read, update, delete) and admin user routes with status codes 401/403/404/422 | tests: other user's id gives 403; unauthenticated gives 401; USER on admin route gives 403 |
| 5 | design | Replace the starter page; layout and navigation; login page; list page with loading, empty and data states | files exist; `npm run build` exits 0 |
| 6 | design | Create/edit wizard with step validation; detail view | each step blocks "Next" on invalid fields; saved row appears in the list |
| 7 | design | Print/PDF view matching the reference; admin users page | print stylesheet exists (`print:` classes and `@page`); admin page redirects a USER |
| 8 | qa | Typecheck, lint, tests, build; cross-user (IDOR) tests; short README with the run steps | all four commands exit 0; README steps copy-paste |

Rules for the table above:
- Merge or drop rows that the request does not need (no wizard, no print view); never add a row with no proof.
- Each row says which files it creates, in the request's folder names.
- A requirement of the request that no row proves is a gap: add it to the row that owns that area.
- Acceptance criteria are written as checks (see rule 14). They are marked done only after the command was run.
- Anything that cannot run here (no database, no browser, no network) is listed under "risks" as "not verifiable here", and the delivery report repeats it.
- Decisions the request leaves open (which document, which layout) go to "questions" AND into `docs/DECISIONS.md` with the choice made, so a later run does not reverse it.
