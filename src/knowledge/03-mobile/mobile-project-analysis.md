# Mobile Project Analysis (do this before changing code)

Do not invent a structure. Learn the real one first, with as few tool calls as needed (one directory tree, then targeted reads).

## 1. Identify the project
- iOS: `*.xcodeproj` / `*.xcworkspace` / `Package.swift` / `Podfile`. Android: `settings.gradle(.kts)`, `app/build.gradle(.kts)`, `AndroidManifest.xml`, `gradle/libs.versions.toml`.
- Test automation: Appium (C#/Java/JS/Python), XCUITest, Espresso, Playwright. Find the test project and its config before writing a test.

## 2. Read the facts
- Versions: Swift/Xcode/deployment target, or Kotlin/AGP/Gradle/compileSdk/minSdk. Dependency manager and the list of dependencies.
- Architecture: where screens, ViewModels, repositories/services, models and DI wiring live. Pick ONE existing, similar feature and read it completely; copy its structure.
- Conventions: naming, folder grouping, navigation approach, state style, error type, logging helper, design-system components, test framework and fakes.
- Build/test entry points: scheme/task names, how tests are run (README, CI file, Makefile, fastlane).

## 3. Decide the smallest safe change
- Reuse an existing pattern or helper before writing a new one. Add a file next to its siblings.
- If the project contradicts the standards (old architecture, legacy libraries), follow the project for this change and mention the gap. Do not migrate unasked.
- New dependency or major version change: stop and ask, with the reason and alternatives.

## 4. Record what you found
- Start your answer or plan with the facts you verified (versions, architecture, similar feature you followed) and mark anything you assumed.
- If a needed fact is missing (which simulator, which backend URL, a secret), ask for it. Do not guess.
