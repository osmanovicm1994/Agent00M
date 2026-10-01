# Native iOS (SwiftUI) Standards

## 1. UI Architecture
- Build exclusively with SwiftUI. UIKit should only be bridged via `UIViewRepresentable` if a native SwiftUI equivalent does not exist.
- Break massive views into small, reusable sub-views. A single SwiftUI `body` should rarely exceed 50 lines.

## 2. State Management (MVVM)
- Separate view logic into `ViewModel` classes.
- For iOS 17+, use the `@Observable` macro. For earlier targets, use `ObservableObject` and `@Published`.
- Never perform heavy computation or network requests directly inside a `.onAppear` closure on the View; delegate to an asynchronous `Task` within the ViewModel.

## 3. Concurrency
- Ban completion handlers. Use Swift structured concurrency (`async/await`, `Task`, `TaskGroup`).
- Ensure UI updates are pushed to the main thread via `@MainActor` annotations on ViewModels.
