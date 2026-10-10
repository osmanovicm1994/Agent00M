# SwiftUI UI Rules

## Composition
- Small, focused views. Pass plain values and closures (`onSave: () -> Void`), not the whole ViewModel, to child views. The screen-level view owns the ViewModel.
- Extract repeated styling into `ViewModifier`s or small styled components instead of copying modifier chains.
- Previews: add a `#Preview` with realistic sample data for each new view, including empty and error states.

## State ownership
- `@State` for view-local value state; `@Binding` for state owned by a parent; `@State private var model = ViewModel()` (iOS 17 `@Observable`) or `@StateObject` (earlier) where the view CREATES the model; `@ObservedObject`/plain parameter where it is passed in.
- Never create a `@StateObject`/model inside `body`. Keep `body` free of side effects and heavy computation.
- Lists need stable identity: use `Identifiable` models with real ids, never array indices for dynamic data.

## Required UI states
- Every data-driven screen handles: loading, empty, content, and error (with a retry action). Disabled and in-progress states for buttons that start async work.
- Error messages are user-facing and actionable; never show raw `error.localizedDescription` from a decoding or network failure without mapping it.

## Design system and Apple conventions
- Reuse the project's colors, fonts, spacing and components. Without a design system, use semantic system styles: `.font(.body)`, `Color.primary`, asset-catalog colors, SF Symbols.
- Follow the Human Interface Guidelines: standard navigation, system controls, safe areas, sheets for focused tasks.
- Support Dark Mode and Dynamic Type; do not hard-code font sizes or colors that break in dark mode. Test layouts at large text sizes and on small and large devices; use `ViewThatFits`/`Grid`/adaptive layouts instead of fixed frames.

## Accessibility (required)
- Every interactive element has an accessibility label (`.accessibilityLabel`) and role; icon-only buttons are never unlabeled. Group related content with `.accessibilityElement(children: .combine)`.
- Touch targets at least 44x44 pt. Do not convey meaning by color alone. Respect `accessibilityReduceMotion`.
- Add a stable `.accessibilityIdentifier("screen.element")` to elements UI tests must find. Identifiers are not user-facing text and do not change with language.

## UIKit interop
- `UIViewRepresentable`: implement `updateUIView` idempotently, keep state in a `Coordinator`, and clean up in `dismantleUIView`.
