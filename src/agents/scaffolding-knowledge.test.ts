import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect } from "vitest";
import { selectTaskKnowledge } from "./orchestration";
import { detectStackKnowledge } from "./helpers";

const scaffoldTask =
  "Create a monorepo in this folder with two apps: apps/web (Next.js App Router, TypeScript, Tailwind CSS) and apps/api (NestJS, TypeScript).";

describe("scaffolding standard", () => {
  it("is loaded for a scaffold task, for the dev agent", () => {
    const picks = selectTaskKnowledge(scaffoldTask, "dev");
    expect(picks.map((p) => p.path)).toContain("12-fullstack/09-scaffolding.md");
  });

  it("is not added to a task that only touches existing code", () => {
    const picks = selectTaskKnowledge("add a health endpoint to the api controller", "dev");
    expect(picks.map((p) => p.path)).not.toContain("12-fullstack/09-scaffolding.md");
  });

  it("carries the facts the first benchmark run got wrong", () => {
    const text = fs.readFileSync(path.join(__dirname, "..", "knowledge", "12-fullstack", "09-scaffolding.md"), "utf8");
    expect(text).toContain("mkdir -p apps");
    expect(text).toContain("not writable");
    expect(text).toMatch(/Never `npm install -g`/);
    expect(text).toContain("create-next-app@latest apps/web");
    expect(text).toContain("@nestjs/cli@latest new api");
    expect(text).toContain("--skip-git");
    expect(text).toContain("--skip-install");
    expect(text).toMatch(/Never run `cd \.\.`/);
  });
});

describe("stack detection in an existing monorepo", () => {
  it("loads the NestJS and Prisma standards from apps/api/package.json", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "stack-test-"));
    try {
      fs.mkdirSync(path.join(root, "apps", "api"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "apps", "api", "package.json"),
        JSON.stringify({ dependencies: { "@nestjs/core": "11.0.0", "@prisma/client": "6.0.0" } }),
      );
      const found = detectStackKnowledge(root, "dev");
      expect(found).toContain("12-fullstack/02-nestjs.md");
      expect(found).toContain("12-fullstack/04-prisma-drizzle.md");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("standards for other stacks, from the task text of a new project", () => {
  const paths = (task: string) => selectTaskKnowledge(task, "dev").map((p) => p.path);

  it("loads the iOS standard for a SwiftUI app and the Android standard for a Kotlin app", () => {
    expect(paths("Create a new iOS app in SwiftUI with a login screen")).toContain("03-mobile/ios-swiftui.md");
    expect(paths("Create an Android app with Kotlin and Jetpack Compose")).toContain("03-mobile/android-compose.md");
  });

  it("loads the FastAPI standard for a Python API", () => {
    expect(paths("Build a FastAPI service with a /health route")).toContain("05-backend/python-fastapi.md");
  });

  it("does not add them to an unrelated task", () => {
    const p = paths("add a health endpoint to the nest api");
    expect(p).not.toContain("03-mobile/ios-swiftui.md");
    expect(p).not.toContain("03-mobile/android-compose.md");
    expect(p).not.toContain("05-backend/python-fastapi.md");
  });
});
