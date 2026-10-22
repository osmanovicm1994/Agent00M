import { describe, it, expect } from "vitest";
import { WorkspaceLocks, relativeInside } from "./workspace-locks";

const SHARED = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".gitignore"];

describe("shared root files are never writable by a parallel worker", () => {
  for (const file of SHARED) {
    it(`${file}: refused with a normal directory scope`, () => {
      const locks = new WorkspaceLocks("/proj");
      locks.tryAcquire("api", ["apps/api/"]);
      expect(locks.canWrite("api", file).allowed).toBe(false);
    });

    it(`${file}: refused even when the plan gives that exact file as a scope`, () => {
      const locks = new WorkspaceLocks("/proj");
      locks.tryAcquire("infra", [file]);
      const d = locks.canWrite("infra", file);
      expect(d.allowed).toBe(false);
      expect(d.reason).toContain("shared file");
    });

    it(`${file}: refused with a whole-workspace scope`, () => {
      const locks = new WorkspaceLocks("/proj");
      locks.tryAcquire("all", ["."]);
      expect(locks.canWrite("all", file).allowed).toBe(false);
    });
  }

  it("nested manifests in an app folder stay writable inside the app's scope", () => {
    const locks = new WorkspaceLocks("/proj");
    locks.tryAcquire("api", ["apps/api/"]);
    expect(locks.canWrite("api", "apps/api/package.json").allowed).toBe(true);
    expect(locks.canWrite("api", "apps/api/src/main.ts").allowed).toBe(true);
  });

  it("a supervisor or sequential owner without a lease is not restricted", () => {
    const locks = new WorkspaceLocks("/proj");
    expect(locks.canWrite("supervisor", "package.json").allowed).toBe(true);
  });
});

describe("relativeInside", () => {
  it("rejects paths outside the root but accepts a folder named ..foo", () => {
    expect(relativeInside("/proj", "../x")).toBeNull();
    expect(relativeInside("/proj", "/other/x")).toBeNull();
    expect(relativeInside("/proj", "..foo/a.txt")).toBe("..foo/a.txt");
  });
});
