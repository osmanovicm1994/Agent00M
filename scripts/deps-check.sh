#!/usr/bin/env bash
# Read-only dependency and toolchain report for any project folder. Changes nothing.
# Usage: bash scripts/deps-check.sh [project-dir]
set -u
DIR="${1:-.}"
cd "$DIR" 2>/dev/null || { echo "Folder not found: $DIR"; exit 2; }
have() { command -v "$1" >/dev/null 2>&1; }
hr() { printf '\n== %s ==\n' "$1"; }
found=0

hr "Toolchain"
if have node; then echo "node $(node -v) / npm $(npm -v 2>/dev/null)"; else echo "node: not installed"; fi
[ -f .nvmrc ] && echo ".nvmrc: $(tr -d '\n' < .nvmrc)"
[ -f .node-version ] && echo ".node-version: $(tr -d '\n' < .node-version)"
if [ -f package.json ] && have node; then
  node -e 'try{const p=require(process.cwd()+"/package.json");if(p.engines)console.log("engines:",JSON.stringify(p.engines));if(p.packageManager)console.log("packageManager:",p.packageManager)}catch(e){}'
fi
if have java; then echo "java: $(java -version 2>&1 | grep -v "Picked up" | head -1)"; else echo "java: not installed"; fi
have python3 && echo "python: $(python3 --version 2>&1)"
have dotnet && echo "dotnet: $(dotnet --version 2>/dev/null)"

if [ -f package.json ]; then
  found=1
  if [ -f pnpm-lock.yaml ]; then pm=pnpm; elif [ -f yarn.lock ]; then pm=yarn; else pm=npm; fi
  hr "Node packages ($pm)"
  if [ ! -d node_modules ]; then echo "node_modules is missing: run the install first (npm ci)."; fi
  case "$pm" in
    npm)  npm outdated 2>&1 | head -40; echo "-- audit (production)"; npm audit --omit=dev 2>&1 | tail -8 ;;
    pnpm) pnpm outdated 2>&1 | head -40 ;;
    yarn) yarn outdated 2>&1 | head -40 ;;
  esac
  echo "(an empty list above means nothing is outdated)"
fi

if ls build.gradle build.gradle.kts settings.gradle settings.gradle.kts >/dev/null 2>&1; then
  found=1
  hr "Gradle"
  if [ -x ./gradlew ]; then ./gradlew --version 2>&1 | grep -E "^(Gradle|Kotlin|JVM|Launcher JVM)" ; else echo "no ./gradlew wrapper found"; fi
  [ -f gradle/libs.versions.toml ] && echo "version catalog: gradle/libs.versions.toml (change versions there)"
  if grep -qs "com.github.ben-manes.versions" build.gradle build.gradle.kts 2>/dev/null; then
    echo "versions plugin applied: run ./gradlew dependencyUpdates"
  else
    echo "versions plugin not applied: ask before adding com.github.ben-manes.versions"
  fi
fi

if [ -f pom.xml ]; then
  found=1
  hr "Maven"
  if [ -x ./mvnw ]; then mvnc=./mvnw; elif have mvn; then mvnc=mvn; else mvnc=""; fi
  if [ -n "$mvnc" ]; then $mvnc -q versions:display-dependency-updates 2>&1 | tail -40; else echo "no mvn or ./mvnw found"; fi
fi

if [ -f requirements.txt ] || [ -f pyproject.toml ]; then
  found=1
  hr "Python (active environment)"
  have python3 && python3 -m pip list --outdated 2>&1 | head -40
fi

if ls ./*.csproj ./*.sln >/dev/null 2>&1; then
  found=1
  hr ".NET"
  have dotnet && { dotnet list package --outdated 2>&1 | head -40; dotnet list package --vulnerable 2>&1 | tail -10; }
fi

if [ -f Podfile ]; then
  found=1
  hr "CocoaPods"
  if have pod; then pod outdated 2>&1 | head -40; else echo "pod not installed"; fi
fi
[ -f Package.swift ] && { found=1; hr "Swift packages"; echo "run: swift package show-dependencies   (update with: swift package update)"; }

[ "$found" = 0 ] && echo "No known dependency manifest found in $(pwd)."
echo
echo "Next: bash scripts/deps-update.sh $DIR --level patch   (npm projects, one package at a time, with checks)"
exit 0
