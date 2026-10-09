# iOS Architecture

## Layers and data flow
- View -> ViewModel -> Repository/Service -> data source (API, database, Keychain, files). Dependencies point inward; a lower layer never imports a higher one.
- Views never talk to `URLSession`, databases or `UserDefaults` directly.
- Domain/business rules live in plain Swift types (no `SwiftUI`/`UIKit` import) so they can be unit-tested without a simulator.

## Project structure
- Follow the existing grouping (by feature or by layer). Default for new code: group by feature (`Features/Profile/ProfileView.swift`, `ProfileViewModel.swift`, `ProfileRepository.swift`), shared code in `Core/` or `Shared/`.
- One primary type per file; file name = type name. Keep models, protocols and implementations findable.
- Large apps: prefer local Swift packages/modules over a growing single target, but do not split modules unasked.

## Dependency injection
- Use what the project already has (initializer injection, an environment/container, a DI library). Do not introduce a DI framework.
- Default: initializer injection of protocols (`protocol ProfileRepository`), with the concrete type created at the composition root (the `App` struct or a container).
- No singletons for anything a test must replace. `.shared` is acceptable only for stateless system wrappers.
- SwiftUI `@Environment`/`EnvironmentObject` is for app-wide values (theme, session), not for hiding a ViewModel's real dependencies.

## ViewModels
- One ViewModel per screen. Expose an immutable-feeling state: a single `State` struct/enum (`loading`, `loaded(Profile)`, `empty`, `failed(UserFacingError)`) rather than many loose booleans.
- Inputs are methods (`func didTapSave()`); outputs are state properties. No `View` or navigation objects inside the ViewModel.
- Cancel work that is no longer needed (`Task` cancellation) when the screen goes away.

## Navigation
- Use the navigation approach already in the project (`NavigationStack` with typed routes, a coordinator/router, UIKit navigation). New SwiftUI code on iOS 16+: `NavigationStack` + `navigationDestination(for:)` with `Hashable` route values.
- Screens do not construct each other's dependencies; routes carry plain values (ids), and the destination loads its own data.
- Handle deep links and back navigation in one place.
