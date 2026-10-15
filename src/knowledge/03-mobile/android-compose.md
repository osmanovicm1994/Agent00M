# Native Android (Kotlin & Jetpack Compose) Standards

Inspect the real project first: Gradle modules, `compileSdk` / `minSdk`, Compose BOM version, DI (Hilt, Koin), navigation, existing architecture and test setup. Follow the project over this file; these are the target for NEW code. Shared rules: `mobile-common.md`.

## 1. UI (Jetpack Compose)
- New screens are written in Compose. Keep existing XML/View screens as they are unless asked to migrate; use `AndroidView` / `ComposeView` to bridge.
- **State hoisting:** composables are as stateless as possible. Data goes down as parameters, events go up as lambdas (`onItemClick: (Int) -> Unit`).
- Do not pass ViewModels down the tree. The screen-level composable collects state (`collectAsStateWithLifecycle`) and passes plain data to children.
- Keep composables small and side-effect free; use `remember`, `derivedStateOf` and stable keys in lists (`LazyColumn(items(key = ...))`). Side effects in `LaunchedEffect` / `DisposableEffect`, never in the composition body.
- Follow the project's Material theme and design system; no hard-coded colors or dimensions where tokens exist.

## 2. State management
- AndroidX `ViewModel` exposes UI state as a single immutable `data class` in a `StateFlow` (MVVM / MVI, whichever the project uses). Events from the UI call ViewModel functions; one-off effects use a channel/shared flow.
- Model loading / content / empty / error explicitly (sealed interface).

## 3. Concurrency
- Kotlin Coroutines and Flow. Do not introduce RxJava into a project that does not use it; leave existing Rx code alone unless asked.
- Launch work from `viewModelScope`; repositories switch to `Dispatchers.IO` for blocking I/O and take the dispatcher as a parameter so tests can replace it. Never block the main thread. Cancellation must propagate (do not swallow `CancellationException`).

## 4. Testability
- `Modifier.testTag("ScreenName.ElementName")` on interactive nodes; for Appium also set `testTagsAsResourceId = true` once at the root (see `appium-standards.md`).
- Done means built and tested: run the project's Gradle tasks (`./gradlew :app:assembleDebug`, unit tests) and report only results you saw.
