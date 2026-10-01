# Golden Rules
1. **Never mix paradigms.** Write idiomatic code for the language at hand: no Java-style OOP in React, no nested functional closures in C# where LINQ is expected.
2. **Design for testability first.** UI must be targetable by Playwright / Appium (stable ids). Business logic is isolated from frameworks so it can be unit tested fast.
3. **Fail fast and explicitly.** Return explicit result types or throw well-typed, domain-specific exceptions. Never swallow exceptions or return an unexplained `null`.
4. **Match the project.** Follow the conventions, frameworks and folder layout already on disk over any generic default.
5. **Smallest correct change.** Do not refactor unrelated code while completing a task.
