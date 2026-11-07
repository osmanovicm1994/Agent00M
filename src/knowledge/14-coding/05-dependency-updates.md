# Updating Dependencies, Node, Java and Other Third Parties Safely

## Rules (all ecosystems)
- An update is its OWN task, never part of a feature task. Start from a clean git state on a branch (`chore/deps-<date>`).
- Look first, change second: run `bash scripts/deps-check.sh <project>` (read only) and read the list.
- Patch and minor updates one package at a time. A MAJOR update only when the person named it: read its release notes first (`web_research` or `query-docs`), then update only that package.
- After EVERY update run the project's checks (typecheck, tests, build). Green = commit (`chore(deps): update <pkg> <old> -> <new>`). Red = roll back that one package and note why.
- Keep the lockfile and commit it. Never delete it, never `--force`, never `npm audit fix --force`.
- Never raise the runtime (Node, JDK, Python) silently: it is the person's decision; give the exact command.
- `bash scripts/deps-update.sh <project> --level patch|minor` does the npm loop above automatically (`npm run deps:update`).

## Node and npm
- Look: `npm outdated`, `npm audit --omit=dev`, `node -v`, `.nvmrc`, `engines` in package.json.
- Update one package: `npm install <pkg>@<version>`. Version check: `npm view <pkg> version engines.node peerDependencies`.
- Roll back: `git checkout -- package.json package-lock.json && npm ci`.
- Node itself: `nvm install <major> && nvm use <major>` (or `fnm`, or `brew install node@<major>`), then update `.nvmrc` and `engines`, then `rm -rf node_modules` only with the person's yes, then `npm ci`.
- pnpm: `pnpm outdated`, `pnpm update <pkg>`; yarn: `yarn outdated`, `yarn upgrade <pkg>`.

## Java, Gradle, Maven (Android and backend)
- Look: `java -version`; on macOS `/usr/libexec/java_home -V` lists the installed JDKs; `./gradlew --version` or `./mvnw -v`.
- JDK install: `brew install --cask temurin@21` or SDKMAN (`sdk list java`, `sdk install java <id>`, `sdk use java <id>`). Point the project at it with `JAVA_HOME`, or `org.gradle.java.home` in `gradle.properties`.
- Gradle wrapper: `./gradlew wrapper --gradle-version <x.y> --distribution-type bin`, then run the build twice (the first run downloads).
- Gradle dependencies: versions live in `gradle/libs.versions.toml` when a version catalog exists; change them there. Report: `./gradlew dependencies --configuration runtimeClasspath`. Updates report only if the `com.github.ben-manes.versions` plugin is applied (`./gradlew dependencyUpdates`); ask before adding a plugin.
- Maven: `./mvnw versions:display-dependency-updates` and `versions:display-plugin-updates`; change the version in `pom.xml`, then `./mvnw -q verify`.
- Android: after changing the Android Gradle Plugin or Kotlin, check the compatibility table in the release notes (AGP, Gradle, Kotlin and JDK must fit together), then `./gradlew assembleDebug`.

## Python, .NET, iOS
- Python: use the project's virtualenv. `python3 -m pip list --outdated`, `python3 -m pip install -U <pkg>`, then update `requirements.txt` or `pyproject.toml` and run the tests. With uv: `uv pip list --outdated`.
- .NET: `dotnet list package --outdated`, `dotnet list package --vulnerable`, `dotnet add package <name> --version <v>`, then `dotnet build` and `dotnet test`.
- iOS: `pod outdated`, `pod update <Pod>` (never a bare `pod update`); Swift packages: `swift package update` or Xcode "Update to Latest Package Versions". Then build for the simulator with `xcodebuild`.

## Report
List per package: old -> new, check result, commit or rollback reason, and what remains outdated (majors waiting for a decision).
