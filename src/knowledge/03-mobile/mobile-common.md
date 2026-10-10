# Shared Mobile Rules (iOS and Android)

## Architecture boundaries
- UI renders state and forwards events. Business rules live outside UI code, data access outside business rules. A screen has one owner of its state (ViewModel).
- Model screen state explicitly: loading, content, empty, error. No raw exceptions or HTTP codes reach the user.

## Error handling
- Fail explicitly with typed errors or result types. Never swallow an error silently, never crash on bad server data (missing/extra fields, unexpected types).
- Handle: offline, timeout, unauthorized (refresh or sign-out), server error, empty response. Offer a retry where the user can act.

## Security and privacy
- Secrets, tokens and personal data never appear in source, logs, analytics or screenshots. Tokens go in the platform secure store (Keychain on iOS, Keystore/EncryptedSharedPreferences on Android).
- No cleartext HTTP, no disabled certificate validation, no blanket "allow all" network settings. Ask for the minimum permissions, with a clear reason.
- Never read or print `.env`, keystores, provisioning profiles or signing credentials.

## Accessibility
- Every interactive element has a meaningful label and role; touch targets at least 44 pt (iOS) / 48 dp (Android); no meaning by color alone; support dynamic type/font scaling and dark mode; respect reduced motion.
- Stable, non-localized test identifiers on elements UI tests need (iOS `accessibilityIdentifier`, Android `testTag`/resource id).

## Logging
- Use the platform logger with levels; no `print`/`Log.d` of sensitive data; nothing noisy in release builds.

## Feature parity (iOS and Android)
- When a feature exists on both platforms, keep behavior, copy, validation rules and error states the same unless a platform convention requires a difference. State the difference when you introduce one.
- Test automation should work the same on both: shared identifier names, same user flows.

## Scope and honesty
- Change only what the task needs. No drive-by refactors, no dependency or version bumps as side effects.
- Never say something builds, passes or works unless you ran it and saw it. Report files changed, commands run, real results, and what is unverified.
