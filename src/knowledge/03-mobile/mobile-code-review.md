# Mobile Code Review Checklist

Review the actual changed files. Report only problems you can point to (file + line/snippet) and a concrete fix.

## Correctness
- Matches the task and acceptance criteria. Loading, empty, error and success states all handled. No force-unwraps/`!!`/`try!` on data that can be missing.
- Concurrency: UI work on the main thread/dispatcher, heavy work off it, cancellation handled, no retain cycles or leaked jobs (`[weak self]`, scoped coroutines/Tasks).

## Architecture and style
- Follows the project's existing patterns; logic not in views/composables; dependencies injected, not created inline; no new framework or dependency without a reason.
- Small focused types and functions; names match the project's conventions; no dead code or commented-out blocks.

## Security and privacy
- No secrets, tokens or personal data in code, logs or tests. Secure storage for credentials. No cleartext traffic, no disabled certificate checks, no over-broad permissions.
- Inputs validated; deep-link/intent/URL handling does not trust external data.

## UI and accessibility
- Labels and roles on interactive elements, 44 pt / 48 dp targets, dynamic type, dark mode, no color-only meaning, identifiers for test automation.

## Tests
- New logic has tests (ViewModel/domain first); tests are deterministic (no sleeps, no real network); no test was skipped, weakened or deleted to get green.
- UI/automation tests use stable identifiers, not visible text.

## Scope and honesty
- Only task-related files changed; no unrelated refactors, version bumps, or build-setting edits.
- The reported build/test results were actually run. Anything not run is stated as unverified.

## Output
- Verdict: PASS or FAIL. Blockers (must fix) separate from warnings (nice to fix). "No issue found" is valid when true.
