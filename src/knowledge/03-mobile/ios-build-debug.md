# iOS Build and Debug

## Discover before building
- `xcodebuild -list` (or `-list -workspace X.xcworkspace`) shows targets, configurations and schemes. Use a scheme that exists. With CocoaPods always build the `.xcworkspace`, never the `.xcodeproj`.
- `xcrun simctl list devices available` shows valid simulators; `xcodebuild -showsdks` shows SDKs. `xcodebuild -version` and `swift --version` show the toolchain. Never invent a simulator name or scheme.

## Build commands
- App: `xcodebuild -workspace X.xcworkspace -scheme <Scheme> -destination 'platform=iOS Simulator,name=<Device>' build` (use `-project X.xcodeproj` when there is no workspace). Pipe through `| tail -n 80` or `xcpretty` only if installed; keep the real exit code in mind (`set -o pipefail`).
- Add `CODE_SIGNING_ALLOWED=NO` for simulator builds that fail only on signing.
- Swift packages: `swift build`, `swift test`.
- Builds can take many minutes. Wait for them; the user can press Ctrl+C. Do not run two builds on the same DerivedData at once.

## Dependencies
- SPM: `swift package resolve`; in Xcode projects resolve with `xcodebuild -resolvePackageDependencies`. Commit `Package.resolved` changes only when a dependency change was intended.
- CocoaPods: `pod install` after a Podfile change, then build the workspace. Do not edit `Pods/` by hand.
- Do not delete DerivedData or caches as a first reaction. Do it only after a targeted diagnosis points at stale build state, and tell the user.

## Debug workflow
1. Reproduce: run the failing build/test and keep the FIRST error (later errors are often cascades). Read the exact file and line from the compiler output.
2. Classify: compile error, linker error (missing framework/target membership/`-ObjC`), signing/provisioning, package resolution, runtime crash, test failure.
3. Form one hypothesis, verify with a read or a small command, then change one thing and re-run. Do not shotgun several changes.
4. Common causes: deployment target too low for an API (`@Observable` needs iOS 17, `NavigationStack` iOS 16); a file missing from the target; Swift 6 strict-concurrency errors (`Sendable`, main-actor isolation); duplicate symbols after adding a package; a scheme that is not shared (`xcshareddata/xcschemes`).
5. Runtime crashes: read the crash log/stack (`Thread 1: Fatal error` line first); typical causes are force-unwraps, out-of-range indices, main-thread violations, missing `Info.plist` usage strings. Console logs: `xcrun simctl spawn booted log stream --predicate 'subsystem == "<bundle id>"'`.
6. Verify the fix by re-running the same command that failed, then the related tests. Report what actually ran.

## Do not
- Do not change signing, provisioning, bundle identifiers, schemes, or build settings to silence an error unless that is the diagnosed cause and the user is told.
- Do not bump the Swift version, Xcode project format, deployment target or package versions as a side effect.
