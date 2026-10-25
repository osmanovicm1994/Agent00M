import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { runTeam } from "./orchestrator";

// runTeam with a fake model and a fake executor: no network, no real agent loop. It checks what the team passes around.

let ws: string;
let logs: string[];
const write = (rel: string, text: string) => {
  const file = path.join(ws, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const PLAN = {
  goal: "Agreements app",
  assumptions: [],
  risks: [],
  questions: [],
  tasks: [
    { role: "api", title: "Agreement API", instructions: "Build the route handlers", acceptance: ["GET /api/agreements returns 401 without a session"] },
    { role: "design", title: "Pages", instructions: "Build the pages", acceptance: ["npm run build exits 0"] },
  ],
};

interface Call {
  agent: string;
  task: string;
  context: string;
}

function fakes(opts: { onDesign?: () => void; writeFiles?: boolean } = {}) {
  const calls: Call[] = [];
  const llmCalls: Array<{ system: string; user: string }> = [];
  const llm = {
    model: "fake",
    async chat(messages: Array<{ role: string; content: string }>) {
      const system = messages[0].content;
      const user = messages[1]?.content ?? "";
      llmCalls.push({ system, user });
      if (system.includes("Project Manager of a small software team")) return { content: JSON.stringify(PLAN) };
      if (system.includes("closing out a piece of work")) return { content: "REPORT" };
      return { content: "" };
    },
  };
  const executor = {
    async run(agent: { id: string }, task: string, context?: string) {
      calls.push({ agent: agent.id, task, context: context ?? "" });
      if (agent.id === "safety") return { finalMessage: "VERDICT: PASS\nCHECKED: x", filesWritten: [], commandsRun: [], stepsTaken: 1 };
      if (agent.id === "design") opts.onDesign?.();
      if (opts.writeFiles) write(`apps/web/src/${agent.id}.ts`, `export const ${agent.id} = "${calls.length}";\n`);
      return { finalMessage: "Done", filesWritten: [`apps/web/src/${agent.id}.ts`], commandsRun: ["npm run build"], stepsTaken: 3 };
    },
  };
  return { llm, executor, calls, llmCalls };
}

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "team-run-"));
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  delete process.env.AGENT_TASKS_DIR;
  // Most tests are not about git; the git tests below switch it on.
  process.env.AGENT_GIT = "0";
});
afterEach(() => {
  delete process.env.AGENT_GIT;
  vi.restoreAllMocks();
  fs.rmSync(ws, { recursive: true, force: true });
});

const run = (f: ReturnType<typeof fakes>, task: string) =>
  runTeam({ llm: f.llm as any, executor: f.executor as any, task, workspaceRoot: ws, approvePlan: false });

describe("runTeam: files named in the request", () => {
  it("gives the planner and every engineer the content of the named spec file", async () => {
    write("ugovorv1.md", "SPEC: buyer, seller, vehicle chassis number");
    const f = fakes();
    await run(f, "Build the app described in ugovorv1.md");
    const pm = f.llmCalls.find((c) => c.system.includes("Project Manager of a small"))!;
    expect(pm.user).toContain("SPEC: buyer, seller, vehicle chassis number");
    const engineers = f.calls.filter((c) => c.agent === "api" || c.agent === "design");
    expect(engineers).toHaveLength(2);
    for (const c of engineers) expect(c.context).toContain("SPEC: buyer, seller, vehicle chassis number");
  });

  it("gives the engineers the original request, not only their ticket", async () => {
    const f = fakes();
    await run(f, "Build the agreements app with roles ADMIN and USER");
    for (const c of f.calls.filter((c) => c.agent === "api")) expect(c.context).toContain("roles ADMIN and USER");
  });

  it("puts an unseen picture into the plan's assumptions and says so in the console", async () => {
    write("ugovor-ep.jpg", "binary");
    const f = fakes();
    const res = await run(f, "Print layout like ugovor-ep.jpg");
    expect(res!.plan.assumptions.join()).toContain("not looked at: ugovor-ep.jpg");
    expect(logs.join("\n")).toContain("Reference files");
    const eng = f.calls.find((c) => c.agent === "design")!;
    expect(eng.context).toContain("NOBODY HAS LOOKED AT THEM");
  });
});

describe("runTeam: honest plan display", () => {
  it("shows planned acceptance checks as open boxes, not as ticks", async () => {
    const f = fakes();
    await run(f, "Build it");
    const out = logs.join("\n");
    expect(out).toContain("☐");
    expect(out).not.toContain("✓ GET /api/agreements");
    expect(out).toContain("planned acceptance check");
  });
});

describe("runTeam: engineers' task text", () => {
  it("always carries the planner's instructions (they steer which standards load)", async () => {
    const f = fakes();
    await run(f, "Build it");
    const api = f.calls.find((c) => c.agent === "api")!;
    expect(api.task).toContain("Agreement API");
    expect(api.task).toContain("Build the route handlers");
  });
});

describe("runTeam: the generated starter page", () => {
  const NEXT = JSON.stringify({ dependencies: { next: "16.4.3" } });
  const STARTER = "export default function Home() { return <p>To get started, edit the page.tsx file.</p>; }";

  it("runs one repair by the design engineer and counts the run as complete once the page is replaced", async () => {
    write("apps/web/package.json", NEXT);
    write("apps/web/src/app/page.tsx", STARTER);
    let designRuns = 0;
    const f = fakes({
      onDesign: () => {
        designRuns++;
        // the second design run is the repair
        if (designRuns === 2) write("apps/web/src/app/page.tsx", "export default function Home() { return <main>Ugovori</main>; }");
      },
    });
    const res = await run(f, "Build the app");
    expect(designRuns).toBe(2);
    expect(res!.complete).toBe(true);
    expect(res!.tasks.some((t) => t.title === "Replace the generated starter page" && t.status === "done")).toBe(true);
  });

  it("is NOT complete when the starter page is still in place after the repair, and the report is told", async () => {
    write("apps/web/package.json", NEXT);
    write("apps/web/src/app/page.tsx", STARTER);
    const f = fakes();
    const res = await run(f, "Build the app");
    expect(res!.complete).toBe(false);
    const report = f.llmCalls.find((c) => c.system.includes("closing out a piece of work"))!;
    expect(report.user).toContain("starterPageStillInPlace");
  });
});

describe("runTeam: local git", () => {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: ws, encoding: "utf8" }).trim();

  beforeEach(() => {
    delete process.env.AGENT_GIT;
  });

  it("builds on a feature branch, one commit per task, and leaves the base branch alone", async () => {
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    write("README.md", "hello\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const base = git("rev-parse", "--abbrev-ref", "HEAD");
    const baseHead = git("rev-parse", "HEAD");

    const res = await run(fakes({ writeFiles: true }), "Build the app");

    expect(res!.git).toBeDefined();
    expect(res!.git!.base).toBe(base);
    expect(res!.git!.feature).toMatch(/^feature\//);
    expect(git("rev-parse", base)).toBe(baseHead);
    const subjects = git("log", "--format=%s", `${base}..${res!.git!.feature}`).split("\n");
    expect(subjects.some((s) => s.startsWith("feat(api)"))).toBe(true);
    expect(subjects.some((s) => s.startsWith("feat(ui)"))).toBe(true);
    expect(git("status", "--porcelain")).toBe("");
    expect(logs.join("\n")).toContain("git merge");
  });

  it("does not use git at all with AGENT_GIT=0", async () => {
    process.env.AGENT_GIT = "0";
    const res = await run(fakes({ writeFiles: true }), "Build the app");
    expect(res!.git).toBeUndefined();
    expect(fs.existsSync(path.join(ws, ".git"))).toBe(false);
  });
});
