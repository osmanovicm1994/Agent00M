# Android Compose UI

Follow the app's theme, typography, shapes and components (Material 3 when the project uses it). Entry file: `android-compose.md`.

## Composables
- Small and focused, PascalCase, stateless where practical: values in, callbacks out. Screen-level composable and/or ViewModel owns orchestration.
- Never do network, database, file or blocking work in a composable; it can recompose at any time and must not rely on running once.
- Reusable components take a `modifier: Modifier = Modifier` parameter and apply it to their root. Modifier order matters.

## State
- Keep state at the lowest common owner. `remember` for composition state, `rememberSaveable` for small UI state that must survive recreation, ViewModel for screen/business state. Do not use `remember` as persistence.
- No duplicated state between ViewModel and composable without a sync rule.

## Side effects
- Side effects never run in the composition body. `LaunchedEffect(keys)` for composition-scoped coroutines (choose keys deliberately), `DisposableEffect` for listeners that need cleanup, `SideEffect` only to publish state to non-Compose code, `rememberCoroutineScope` for user-triggered work.
- Do not launch duplicate requests from recomposition.

## Layout and performance
- `LazyColumn` / `LazyRow` / grids for long lists, with stable `key`s. Do not nest same-direction scrollables. Handle window insets; no hard-coded status/navigation bar sizes.
- Measure before optimizing; no premature caching. Use `derivedStateOf` / `remember` for expensive derived values.

## Accessibility and input
- `contentDescription` for icon-only actions and images; touch targets at least 48dp; no meaning by color alone; support font scaling (no fixed heights that clip text); sufficient contrast.
- Forms: proper keyboard types, IME actions, autofill hints; validation message next to the field; guard against double submit while a request runs.

## States and feedback
- Handle loading, content, empty, error, offline and permission-denied where relevant. Preserve user input when a request fails. Consistent snackbars, dialogs and inline errors; confirm destructive actions.

## Navigation and events
- Reusable UI takes callbacks, not a NavController. Prevent repeated navigation from recomposition or replayed events.

## Previews and testability
- `@Preview` for reusable components and key screen states with realistic sample data (loading, empty, error, populated).
- `Modifier.testTag("Screen.Element")` where semantics are not enough; for Appium also set `testTagsAsResourceId = true` at the root.
