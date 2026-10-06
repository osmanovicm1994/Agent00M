# Debugging Playbook (any stack)

## Triage order: cheapest and most common cause first
1. Wrong place or wrong command: cwd, script name, package/app filter, a missing argument.
2. Dependencies: not installed, installed with another package manager, lockfile newer than node_modules, a workspace package not built yet.
3. Runtime version: compare the running version with .nvmrc / engines / .tool-versions / global.json / pyproject.
4. Stale artifacts: build output, framework caches (.next, dist, .turbo, __pycache__, bin/obj), generated code (Prisma client, GraphQL types, protobuf).
5. Config and environment: missing or misnamed variable, wrong env file, wrong URL or port.
6. Services: database, cache or API the app needs is not running or not reachable.
7. Port already in use.
8. The code itself: look at `git diff` and `git log` first; the cause is usually in what changed last.

## Reading output
- The FIRST error is the cause; everything after it is usually a cascade. Search for "Caused by", "Error:", "error TS", "error CS", "FAILED".
- Warnings matter only if they appear right before the failure.
- A stack trace: find the first frame that is YOUR code, not node_modules / framework internals.
- Exit code 0 with a wrong result is a logic bug; non-zero with no message: re-run with verbose or debug flags.
- A dev server that is still running when the timeout hits started successfully; judge it by its output.

## Node / TypeScript
- `Cannot find module 'x'`: is it in package.json? installed? For a workspace package: is it built, and do its `main` / `exports` point to files that exist? TS path aliases (`paths`) work at compile time only; at runtime they need a bundler, tsconfig-paths or relative imports.
- `ERR_REQUIRE_ESM`, `Cannot use import statement outside a module`, `exports is not defined`: ESM/CJS mismatch. Check `"type"` in package.json, `module` / `moduleResolution` in tsconfig, file extensions.
- `EADDRINUSE`: find the process with `lsof -nP -iTCP:<port> -sTCP:LISTEN` before stopping anything; it may be a leftover run of the same dev server.
- `ENOENT`: wrong path or cwd; print the resolved absolute path.
- `ECONNREFUSED`: the target service is down or the host/port is wrong (inside Docker, localhost is not the host).
- Type errors: fix the first one; later ones often disappear.
- Monorepos (npm/pnpm/yarn workspaces, Turborepo, Nx): run the failing script for ONE package (`--filter`, `-w`, `nx run`); build the packages it depends on first; check hoisting and duplicate copies of the same library (two Reacts, two class-validator).

## NestJS
- `Nest can't resolve dependencies of X (?, Y)`: the provider at the `?` position is not available in X's module. Add the module to `imports`, export the provider from its module, or add it to `providers`. Circular import: `forwardRef()` or restructure.
- Startup crash before listening: config validation (ConfigModule schema), database connection, a missing env value. Read the first error, not the Nest bootstrap noise.
- ORM: Prisma client not generated (`prisma generate`) or schema and database out of sync; TypeORM entity glob not matching compiled files.
- A route returns 404/401 unexpectedly: global prefix, versioning, guard order, `@Public()` style decorators.

## Next.js / React
- Server vs client boundary: hooks, browser APIs or event handlers in a Server Component need `"use client"`; server-only code imported in a client file.
- Hydration mismatch: output differs between server and browser (dates, random, `window`, locale).
- `NEXT_PUBLIC_` is required for browser-visible env values; env values are read at build time.
- Odd build errors: delete `.next` only after confirming the cause is stale cache; check the Node version first.

## Python / .NET / JVM / Go / Rust
- Python: `ModuleNotFoundError` means the wrong interpreter or venv is active, or the package is not installed in editable mode; circular imports; version-specific syntax.
- .NET: `dotnet restore` first; `CS####` compiler errors, `NU####` package errors; SDK version vs global.json; port bindings in launchSettings.json.
- Gradle / Maven: wrong JDK, dependency resolution, stale build directory. Go: module path, `go mod tidy`, build tags. Rust: feature flags, lockfile, toolchain version.
- iOS / Android builds: CocoaPods not installed, Xcode / Gradle version mismatch, missing signing or SDK path.

## Intermittent or flaky failures
- Suspect, in order: shared state between tests, ordering, timing and races, time zones, network, resource limits.
- Reproduce with repetition (run it 10-20 times) and isolate; never "fix" it with a sleep or retry.

## Evidence rules
- Change ONE thing at a time, then re-run. Keep a note of what you tried and what it showed.
- A fix is not done until the original command succeeds. State the command and the result.
- If the root cause is outside the code (version, env value, running service), report the exact command or setting to change instead of editing code.
