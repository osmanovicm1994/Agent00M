# Android Compose UI Standards

## 1. Core rules

-   Use **Kotlin and Jetpack Compose** for new native Android UI.
-   Do not add XML layouts for new screens. Use XML only when explicitly
    required by the task or when maintaining an existing XML-based
    component.
-   Prefer Material 3 when it is already used by the project. Do not mix
    design systems without a clear reason.
-   Follow the app's existing theme, typography, shapes, spacing, and
    component conventions.
-   Build accessible, responsive UI that works across supported screen
    sizes, font scales, and system settings.

## 2. Composable design

-   Keep composables focused and small enough to understand. Extract a
    component when it has a clear purpose, meaningful reuse, or improves
    readability.
-   Use PascalCase for composable function names and descriptive names
    that reflect their UI responsibility.
-   Prefer stateless reusable composables: pass values in and callbacks
    out.
-   Keep screen-level orchestration in a screen composable and/or
    ViewModel; avoid turning every visual component into a state owner.
-   Avoid deeply nested composables, huge parameter lists, and
    unnecessary wrapper functions.
-   Do not perform network, database, file, or other blocking operations
    directly inside a composable.
-   Composable functions may be recomposed at any time; never rely on
    them running exactly once.

## 3. State hoisting and UI state

-   **State hoisting:** composables should be as stateless as practical.
    Pass state down through parameters and events up through lambdas.
-   Keep each piece of state at the lowest common owner that needs to
    coordinate it.
-   Use `remember` for composition-scoped state and `rememberSaveable`
    for small UI state that should survive recreation when supported.
-   Use a ViewModel for screen/business state that needs lifecycle-aware
    ownership.
-   Expose immutable state to the UI and update it through explicit
    events.
-   Collect `Flow` or `StateFlow` using lifecycle-aware collection,
    normally `collectAsStateWithLifecycle()`.
-   Avoid duplicating the same state in a ViewModel and composable
    without a defined synchronization rule.
-   Never use `remember` as a substitute for a repository or durable
    persistence.

## 4. Side effects

-   Keep side effects out of the composable body.
-   Use `LaunchedEffect` for coroutine work tied to composition and
    keyed to the values that define when it should restart.
-   Use `DisposableEffect` when registering a listener or resource that
    must be cleaned up.
-   Use `SideEffect` only to publish Compose state to non-Compose code
    after a successful recomposition.
-   Use `rememberCoroutineScope` for user-triggered coroutine work owned
    by the composition; prefer ViewModel-owned work for screen/business
    operations.
-   Choose effect keys deliberately. Avoid constant or unstable keys
    that cause repeated work.
-   Do not launch duplicate requests from recomposition.

## 5. Layout, modifiers, and performance

-   Apply modifiers in a deliberate order; modifier order can change
    behavior.
-   Use `Modifier` parameters for reusable UI components and apply
    caller-provided modifiers predictably.
-   Prefer lazy containers (`LazyColumn`, `LazyRow`, grids) for long or
    potentially large lists.
-   Provide stable keys for lazy-list items when items have stable
    identities.
-   Avoid expensive calculations and object creation during frequent
    recomposition; use `remember` or derived state when profiling or
    semantics justify it.
-   Do not prematurely optimize. Measure before adding complex caching
    or custom layout logic.
-   Avoid nesting scrollable containers in ways that create conflicting
    scroll behavior.
-   Use appropriate window insets and avoid hard-coded assumptions about
    status/navigation bars.

## 6. Accessibility and interaction

-   Provide meaningful accessible labels for icon-only actions and
    non-text controls.
-   Ensure touch targets are comfortably usable and follow Material
    accessibility guidance.
-   Do not communicate status or errors using color alone.
-   Support system font scaling; avoid fixed heights that clip text.
-   Ensure adequate contrast and visible focus/selection states.
-   Group related semantics and merge or clear semantics only when it
    improves assistive-technology behavior.
-   Use appropriate keyboard types, IME actions, autofill hints, and
    input validation for forms.
-   Disable or guard repeated submission while an operation is in
    progress.

## 7. UI states and feedback

-   Design loading, success, empty, error, offline, and
    permission-denied states where relevant.
-   Keep validation messages near the field or action they describe.
-   Preserve user input when recoverable requests fail.
-   Use snackbars, dialogs, banners, and inline errors consistently with
    the design system.
-   Do not display raw exceptions or internal server responses.
-   Make destructive actions clear and provide confirmation when the
    impact warrants it.

## 8. Navigation and events

-   Prefer callbacks for reusable UI components instead of coupling them
    to a navigation controller.
-   Use the project's established navigation solution and typed route
    conventions where available.
-   Prevent accidental repeated navigation caused by recomposition or
    replayed events.
-   Handle back behavior and system navigation predictably.
-   Keep navigation and one-off UI events separate from persistent UI
    state where appropriate.

## 9. Previews and design consistency

-   Add `@Preview` examples for reusable components and important screen
    states when practical.
-   Use realistic sample data and avoid requiring live services for
    previews.
-   Preview loading, empty, error, and populated states for complex
    screens.
-   Reuse design tokens and shared components rather than duplicating
    style values.
-   Do not create a generic design system abstraction for a single use
    unless it meaningfully improves consistency.

## 10. Compose UI review checklist

-   [ ] New UI uses Compose unless the task explicitly requires
    otherwise.
-   [ ] State is hoisted and has a clear owner.
-   [ ] Side effects use the correct effect/lifecycle mechanism.
-   [ ] No blocking work occurs during composition.
-   [ ] Loading, empty, error, and success states are covered.
-   [ ] Accessibility labels, touch targets, contrast, and font scaling
    are considered.
-   [ ] Lazy lists use stable keys when appropriate.
-   [ ] Previews and UI tests cover important states.
