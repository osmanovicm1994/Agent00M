import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { selectTaskKnowledge } from "./orchestration";
import { loadProjectContext } from "./helpers";

const paths = (task: string, agent = "dev", limit = 40) => selectTaskKnowledge(task, agent, limit).map((p) => p.path);

describe("full-stack task standards", () => {
  const BIG =
    "Build a full-stack app from scratch with Next.js and NestJS, Prisma on Neon, Cloudflare R2 uploads, custom JWT auth, " +
    "Docker deployment to a VPS and Playwright e2e tests on GitHub Actions";

  it("puts the build protocol first for a from-scratch project", () => {
    const picks = selectTaskKnowledge(BIG, "dev");
    expect(picks[0].path).toBe("12-fullstack/00-build-protocol.md");
  });

  it("loads every building block the task names when there is room", () => {
    const all = paths(BIG);
    for (const f of [
      "12-fullstack/01-nextjs-app-router.md",
      "12-fullstack/02-nestjs.md",
      "12-fullstack/03-auth-jwt.md",
      "12-fullstack/04-prisma-drizzle.md",
      "12-fullstack/05-neon-postgres.md",
      "12-fullstack/06-cloudflare-r2.md",
      "12-fullstack/07-docker-deploy.md",
      "12-fullstack/08-ci-testing.md",
    ]) {
      expect(all, f).toContain(f);
    }
  });

  it("respects the file limit", () => {
    expect(selectTaskKnowledge(BIG, "dev", 3)).toHaveLength(3);
  });

  it("does not mistake the English word next for Next.js", () => {
    expect(paths("move on to the next step and rename foo to bar")).toEqual([]);
  });

  it("adds the OWASP checklist for security reviews", () => {
    expect(paths("do an OWASP security review of the auth module")).toContain("07-api/05-owasp-checklist.md");
  });

  it("gives nothing to agents that write no code", () => {
    expect(paths(BIG, "research")).toEqual([]);
    expect(paths(BIG, "kb-harvester")).toEqual([]);
  });
});

describe("loadProjectContext", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ctx-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("returns nothing when the project has no rules file", () => {
    expect(loadProjectContext(tmp())).toBe("");
  });

  it("reads AGENTS.md and CLAUDE.md under a clear heading", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "AGENTS.md"), "Use pnpm, never npm.");
    fs.writeFileSync(path.join(d, "CLAUDE.md"), "API lives in apps/api.");
    const text = loadProjectContext(d);
    expect(text).toContain("PROJECT RULES");
    expect(text).toContain("Use pnpm, never npm.");
    expect(text).toContain("API lives in apps/api.");
    expect(text.indexOf("AGENTS.md")).toBeLessThan(text.indexOf("CLAUDE.md"));
  });

  it("caps the total size and marks the cut", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "AGENTS.md"), "x".repeat(10_000));
    const text = loadProjectContext(d, 1000);
    expect(text.length).toBeLessThan(1500);
    expect(text).toContain("[...truncated]");
  });
});
