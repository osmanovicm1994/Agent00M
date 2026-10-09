# iOS Data and Networking

## Networking
- Use the project's existing network layer. If there is none, use `URLSession` with `async/await` (`try await session.data(for:)`) behind a small protocol, not scattered calls.
- Network code lives in a Service/Repository/API client, never in a View or ViewModel body.
- Build requests in one place: base URL from configuration, headers, timeout. Set explicit timeouts. Check `HTTPURLResponse.statusCode` (2xx) before decoding.
- Decode with `Codable`/`JSONDecoder`. Set the key strategy deliberately (`.convertFromSnakeCase` or explicit `CodingKeys`) and the date strategy. Make optional server fields optional; a missing field must not crash the app.

## Errors
- Model failure explicitly: `throws` with a typed `enum NetworkError: Error` (offline, timeout, unauthorized, server(status), decoding, unknown) or a `Result`. Never `try?` away an error that the user or a log should see; never `try!`/force-unwrap in app code.
- Map technical errors to user-facing messages in the ViewModel. Handle: no connection (`URLError.notConnectedToInternet`), timeout, 401 (session refresh or sign-out), 5xx (retry option), invalid response.
- Retry only idempotent requests, with backoff and a limit. Support cancellation (`Task.isCancelled`, `URLError.cancelled` is not an error to show).

## Persistence
- Use what the project has (SwiftData, Core Data, SQLite wrapper, files). New persistence on iOS 17+: SwiftData; older: Core Data. Do not add a second store.
- `UserDefaults`/`@AppStorage` only for small non-sensitive preferences.
- Tokens, passwords and secrets go in the Keychain, never `UserDefaults`, files, or source code.
- Keep database/file access off the main thread (an actor or background context); expose async APIs.
- Offline behavior: decide per feature whether to show cached data, queue writes, or show an offline state, and implement it explicitly.

## Security and privacy
- Do not log tokens, passwords, personal data or full request/response bodies in release builds. Use `os.Logger` with privacy annotations (`\(value, privacy: .private)`).
- Keep App Transport Security enabled; do not add `NSAllowsArbitraryLoads` or disable certificate checks to make something work.
- Do not commit API keys; use build configuration / xcconfig that is git-ignored, and tell the user where a secret must be supplied.
- Request only the permissions the feature needs; every permission needs its `Info.plist` usage description.
