# Native iOS (Swift & SwiftUI) Standards

Entry point for iOS. Focused rules live in `ios-architecture.md`, `ios-swiftui-ui.md`, `ios-data-networking.md`, `ios-testing.md`, `ios-build-debug.md` (the agent gets the ones that fit its role). Shared mobile rules: `mobile-common.md`.

## 1. Repository-first development (mandatory)
- Before changing code, inspect the real project: `.xcodeproj`/`.xcworkspace`/`Package.swift`, targets and schemes, deployment target, Swift version, dependency manager (SPM, CocoaPods, Carthage), and the files related to the task.
- Identify what the app already uses: architecture, navigation, DI approach, networking layer, persistence, test framework, naming. Read the existing implementation before creating new files.
- Prefer the project's established patterns over new architecture. This document is the target standard for NEW code; do not migrate existing code unless asked.
- If existing code conflicts with these standards, name the conflict and make the smallest safe change.
- Never invent types, APIs, packages or file paths. Verify with `grep`/`read_file` first.

## 2. UI (SwiftUI)
- Build new UI with SwiftUI. Use UIKit only through `UIViewRepresentable`/`UIViewControllerRepresentable` when SwiftUI has no equivalent, or inside existing UIKit screens.
- Break large views into small sub-views. A `body` should rarely exceed ~50 lines.
- Follow the project's design system (colors, fonts, spacing, components) before adding new styles.

## 3. State management (MVVM)
- Put view logic in a `ViewModel`. Views render state and send events; they hold no business logic.
- iOS 17+ targets: `@Observable`. Earlier targets: `ObservableObject` + `@Published`. Check the deployment target first.
- No heavy work or network calls directly in `.onAppear`; start a `Task` (or use `.task`) that calls the ViewModel.

## 4. Concurrency
- New code uses Swift concurrency (`async/await`, `Task`, `TaskGroup`, actors). Wrap legacy completion-handler APIs with `withCheckedThrowingContinuation` instead of adding new completion handlers.
- ViewModels that publish UI state are `@MainActor`. Never block the main thread.
- Do not rewrite existing Combine/completion-based modules unless asked; do not start new Combine pipelines when `async/await` does the job.

## 5. Dependencies and technology
- Reuse existing libraries and project helpers. Add a package only when the project cannot do it safely itself, and say why.
- Never change the Swift version, deployment target, or a package's major version without approval. Check compatibility with the configured Xcode/Swift version.

## 6. Done means verified
- Build the affected scheme and run the relevant tests. Report only results you actually saw. Never claim a build passes unless it ran successfully.
- Final report: files changed, commands run, test results, failures, open issues.
