# Android Build and Debug

## Gradle and configuration
- Inspect the wrapper, AGP, Kotlin, JDK and SDK versions before touching build config. Use `./gradlew` (or `gradlew.bat`), never a global Gradle. Keep versions in the project's version catalog or convention plugins.
- No upgrades of Gradle, AGP, Kotlin or major dependencies inside an unrelated change. No machine-specific paths or secrets in Gradle files; the build must work on a clean checkout and in CI.
- Follow existing flavors, build types, signing and environment config. Never disable minification, lint, tests or security checks to hide a problem. Never commit keystores or passwords. Check that each variant uses the right application id, endpoint and flags.

## Commands (project root, wrapper)
```
./gradlew tasks
./gradlew assembleDebug
./gradlew testDebugUnitTest      # or: ./gradlew test
./gradlew lintDebug              # or: ./gradlew lint
./gradlew connectedDebugAndroidTest   # needs an emulator or device
```
Run the narrowest relevant task first, then broader checks. Add `--stacktrace` or `--info` for targeted diagnosis; `--debug` only when needed (large, may expose sensitive data).

## Debug workflow
1. Reproduce and note the variant, device or emulator, and API level.
2. Read the FIRST meaningful error in Gradle output or Logcat; later errors are often cascades.
3. Classify: configuration, compilation, dependency resolution, runtime/lifecycle, network, device-specific.
4. Make the smallest change, re-run the failing task, then the related tests. For generated code or config changes, also do a clean build.
5. Report the checks actually run and remaining uncertainty.

## Logcat and devices
- `adb devices`, `adb logcat` (filter by package, tag or level), `adb logcat -s AndroidRuntime`. Keep full stack traces and causes; redact tokens and personal data before sharing logs.
- ADB trouble: check `adb devices`, cable/USB mode and authorization; restart with `adb kill-server && adb start-server` only if needed. Emulator trouble: logs, disk space, virtualization, system-image compatibility. Emulators do not reproduce OEM or hardware behavior.

## Dependency and build failures
- Inspect resolution errors, repositories, version conflicts and JDK/AGP compatibility before changing versions. Do not force versions or add duplicate repositories without understanding the conflict. Check KSP/KAPT compatibility for generated sources.
- Do not delete caches or `clean` as a first reaction; confirm the cause first. Warnings are not failures unless configured as errors.

## Release readiness
- Profile startup, rendering, memory and battery instead of guessing. Validate release builds (shrinking, obfuscation, resources), exported components, manifest and network security config. Logs and crash reports must not leak secrets or personal data.
