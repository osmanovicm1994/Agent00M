# Android Build and Debug Standards

## 1. Gradle and project configuration

-   Inspect the project's Gradle wrapper, Android Gradle Plugin (AGP),
    Kotlin, JDK, and SDK versions before changing build configuration.
-   Use the repository's Gradle wrapper (`./gradlew` or `gradlew.bat`)
    rather than a globally installed Gradle version.
-   Keep plugin and dependency versions centralized using the project's
    existing version catalog or convention plugins.
-   Avoid upgrading Gradle, AGP, Kotlin, or major dependencies as part
    of an unrelated feature.
-   Do not hard-code local machine paths or commit machine-specific
    configuration.
-   Keep secrets out of Gradle files and source control; use approved
    local/CI secret configuration.
-   Prefer configuration that works on a clean checkout and in CI.

## 2. Build variants and configuration

-   Follow existing product flavors, build types, signing setup, and
    environment configuration.
-   Keep debug and release behavior intentionally separated.
-   Do not disable minification, lint, tests, or security checks merely
    to hide a build problem.
-   Never commit signing keys, keystores, passwords, or production
    credentials.
-   Verify that the correct application ID, endpoint, and feature flags
    are used for each variant.
-   Avoid leaking production endpoints or sensitive configuration into
    debug logs and artifacts.

## 3. Standard commands

Run commands from the Android project root. Use the Gradle wrapper.

### macOS/Linux

``` bash
./gradlew tasks
./gradlew assembleDebug
./gradlew test
./gradlew lint
./gradlew connectedDebugAndroidTest
```

### Windows

``` bat
gradlew.bat tasks
gradlew.bat assembleDebug
gradlew.bat test
gradlew.bat lint
gradlew.bat connectedDebugAndroidTest
```

Run the narrowest relevant task first, then broader checks as time and
environment allow. Some tasks may require an emulator or connected
device.

## 4. Debugging workflow

1.  Reproduce the issue and record the exact steps, build variant,
    device/emulator, and API level.
2.  Read the first meaningful error in Gradle output or Logcat; later
    errors may be cascading failures.
3.  Determine whether the failure is configuration, compilation,
    dependency resolution, runtime, lifecycle, network, or
    device-specific.
4.  Make the smallest targeted change and rerun the failing task.
5.  Run relevant tests and a clean build when the change could affect
    generated code or configuration.
6.  Report the actual checks performed and any remaining uncertainty.

## 5. Logcat and diagnostics

-   Use Android Studio Logcat or `adb logcat` to capture runtime errors.
-   Filter by package, process, tag, or severity to reduce noise.
-   Preserve stack traces and the original exception cause when
    diagnosing failures.
-   Redact tokens, passwords, session identifiers, personal data, and
    sensitive payloads before sharing logs.
-   Do not leave verbose debug logging of sensitive data enabled in
    release builds.
-   Avoid swallowing exceptions or replacing useful diagnostics with
    generic messages.

Example:

``` bash
adb devices
adb logcat
adb logcat -s AndroidRuntime
```

## 6. Emulator and device troubleshooting

-   Confirm the selected device is online and the expected API level is
    installed.
-   For ADB issues, check `adb devices`, cable/USB mode, device
    authorization, and OEM drivers on Windows.
-   Restart the ADB server only when needed:

``` bash
adb kill-server
adb start-server
adb devices
```

-   For emulator issues, check emulator logs, available disk space,
    virtualization support, and system-image compatibility.
-   Do not assume an emulator reproduces OEM-specific behavior or
    physical hardware capabilities.
-   For permissions, notifications, background execution, and
    biometrics, validate on appropriate API levels and real devices when
    necessary.

## 7. Dependency and build failures

-   Inspect dependency-resolution errors, repository configuration,
    version conflicts, and JDK/AGP compatibility before changing
    versions.
-   Use `--stacktrace` or `--info` for targeted diagnostics; use
    `--debug` only when necessary because it can produce large,
    sensitive logs.
-   Avoid deleting caches as a first response. Confirm the cause before
    using `clean` or invalidating caches.
-   Do not add duplicate repositories or force dependency versions
    without understanding the conflict.
-   Check generated sources, KSP/KAPT configuration, and annotation
    processor compatibility when relevant.
-   Treat deprecation warnings separately from actual build failures
    unless warnings are configured as errors.

Example:

``` bash
./gradlew assembleDebug --stacktrace
./gradlew testDebugUnitTest
./gradlew lintDebug
```

## 8. Performance and release readiness

-   Measure startup, rendering, memory, and battery issues with
    appropriate profiling tools rather than guessing.
-   Validate release builds, shrinking/obfuscation, resource handling,
    and app startup where applicable.
-   Check app permissions, exported components, network security
    configuration, and manifest changes during release review.
-   Ensure crash reporting and logging do not expose secrets or personal
    data.
-   Confirm build artifacts and test reports are generated at expected
    paths before relying on them in CI.

## 9. Build/debug review checklist

-   [ ] Wrapper and toolchain versions are respected.
-   [ ] No unrelated dependency or plugin upgrades were introduced.
-   [ ] Debug and release configuration remain correct.
-   [ ] Errors were diagnosed from primary evidence, not guessed at.
-   [ ] Relevant tests, lint, and build tasks were run or clearly marked
    as not run.
-   [ ] Logs and artifacts contain no secrets or unnecessary personal
    data.
-   [ ] Device-specific behavior is validated on appropriate hardware
    when needed.
