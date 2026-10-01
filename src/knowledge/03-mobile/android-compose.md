# Native Android (Kotlin & Jetpack Compose) Standards

## 1. Declarative UI (Jetpack Compose)
- All new UI must be written in Jetpack Compose. XML layouts are prohibited.
- **State Hoisting:** Composable functions should be as stateless as possible. Pass data down via parameters and pass events up via lambda functions (e.g., `onItemClick: (Int) -> Unit`).
- Do not pass ViewModels down through the Composable tree. Extract state in the top-level screen composable and pass raw data classes down.

## 2. State Management (MVI/MVVM)
- Use AndroidX `ViewModel`. Expose UI state using Kotlin `StateFlow`.
- Define a single immutable data class for the screen state (`data class ProfileState(...)`).

## 3. Concurrency
- Use Kotlin Coroutines exclusively. RxJava is prohibited.
- Launch asynchronous work using `viewModelScope.launch`.
- Ensure repository database reads/writes run on `Dispatchers.IO`.
