# Golden Rules
1. **Match the project.** Follow the conventions, frameworks, versions and folder layout already on disk over any generic default or any standard below. The standards are the target for NEW code; do not migrate existing code unless asked.
2. **Smallest correct change.** Do not refactor unrelated code, rename things or bump dependency versions while completing a task.
3. **Never mix paradigms.** Write idiomatic code for the language at hand: no Java-style OOP in React, no nested functional closures in C# where LINQ is expected.
4. **Design for testability.** UI must be targetable by Playwright / Appium (stable ids). Business logic is isolated from frameworks so it can be unit tested fast.
5. **Fail fast and explicitly.** Return explicit result types or throw well-typed, domain-specific exceptions. Never swallow exceptions or return an unexplained `null`.
6. **No new dependency without a reason.** Use what is installed or the platform first; if you add a package, say why.
7. **Secrets stay out.** Never put keys, tokens or passwords in code, logs, tests or docs. Read configuration from the environment.
8. **Prove it.** A task is done when a command you ran shows it works (typecheck, test, build). Say what you did not verify.
