import { describe, it, expect } from "vitest";
import { clampTimeoutMs } from "./shell.tool";

const LONG = clampTimeoutMs(undefined, "npm run build"); // no hint: the long default

describe("clampTimeoutMs for platform toolchains", () => {
  it.each([
    "xcodegen generate",
    "pod install",
    "xcodebuild -scheme App build",
    "./gradlew assembleDebug",
    "flutter pub get",
    "flutter test",
    "cargo test",
    "cargo check",
    "go build ./...",
    "go test ./...",
    "dotnet restore",
    "npx prisma migrate dev --name init",
    "npx prisma generate",
  ])("does not let a short hint cut %s", (cmd) => {
    expect(clampTimeoutMs(30, cmd)).toBe(LONG);
  });

  it("still honours the hint for a server that never exits", () => {
    expect(clampTimeoutMs(60, "npm run dev")).toBe(60_000);
    expect(clampTimeoutMs(45, "docker compose up")).toBe(45_000);
  });

  it("uses the long limit when there is no hint", () => {
    expect(clampTimeoutMs(undefined, "cargo build")).toBe(LONG);
    expect(clampTimeoutMs(0, "go test ./...")).toBe(LONG);
  });
});
