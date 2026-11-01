import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { runTeam, validatePlanCoverage } from "./orchestrator";

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

// A valid plan whose coverage map quotes the first words of the request, the way a real planner does. The validator checks every
// quote against the request, so a fixture without a coverage map would be rejected.
function planFor(user: string) {
  const request = /<request>\n([\s\S]*?)\n<\/request>/.exec(user)?.[1] ?? "";
  const quote = request.split(/\s+/).slice(0, 3).join(" ");
  return {
    ...PLAN,
    coverage: PLAN.tasks.map((t, i) => ({ requirement: quote, task: i + 1, acceptance: t.acceptance[0] })),
  };
}

interface Call {
  agent: string;
  task: string;
  context: string;
}

function fakes(opts: { onDesign?: () => void; writeFiles?: boolean; plan?: (user: string) => unknown } = {}) {
  const calls: Call[] = [];
  const llmCalls: Array<{ system: string; user: string; noCache?: boolean }> = [];
  const llm = {
    model: "fake",
    async chat(messages: Array<{ role: string; content: string }>, _tools?: unknown, options?: { noCache?: boolean }) {
      const system = messages[0].content;
      const user = messages[1]?.content ?? "";
      llmCalls.push({ system, user, noCache: options?.noCache });
      if (system.includes("Project Manager of a small software team")) return { content: JSON.stringify(opts.plan ? opts.plan(user) : planFor(user)) };
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

describe("runTeam: size of the engineers' first message", () => {
  it("keeps the notes of earlier tasks within a fixed budget, newest first", async () => {
    const { recentNotes } = await import("./orchestrator");
    const notes = Array.from({ length: 12 }, (_, i) => `- task ${i + 1}: ${"x".repeat(400)}`);
    const out = recentNotes(notes, 3000);
    expect(out.length).toBeLessThan(3300);
    expect(out).toContain("task 12");
    expect(out).not.toContain("task 1:");
    expect(out).toContain("earlier task note(s) left out");
    expect(recentNotes(["- a", "- b"], 3000)).toBe("- a\n- b");
    expect(recentNotes([], 3000)).toBe("");
  });

  it("puts the referenced files before the research brief and keeps the whole assignment bounded", async () => {
    write("ugovorv1.md", "# Agreement rules\nThe commission is paid on delivery.\n");
    const f = fakes();
    await runTeam({ llm: f.llm as any, executor: f.executor as any, task: "Build it as described in ugovorv1.md", workspaceRoot: ws, approvePlan: false, context: "BRIEF ".repeat(3000) });
    const eng = f.calls.find((c) => c.agent === "api")!;
    const full = `${eng.task}\n${eng.context}`;
    expect(full.indexOf("commission is paid")).toBeGreaterThan(-1);
    expect(full.indexOf("commission is paid")).toBeLessThan(full.indexOf("BRIEF"));
    expect(eng.context.length).toBeLessThan(30000);
  });
});

describe("validatePlanCoverage", () => {
  const source = "- Require an authenticated `ADMIN` session for every admin page and mutation.\n- Status values are `DRAFT`, `PUBLISHED`, `ARCHIVED`.";
  const task = (role: string) => ({ role, title: "t", instructions: "", acceptance: ["A1"], scope: [], dependsOn: [] });
  const plan = (roles: string[], coverage: unknown[]) =>
    ({ goal: "g", assumptions: [], risks: [], questions: [], tasks: roles.map(task), coverage }) as any;

  it("accepts a quote whose Markdown marks the planner dropped", () => {
    const p = plan(["api"], [{ requirement: "Require an authenticated ADMIN session for every admin page and mutation", task: 1, acceptance: "A1" }]);
    const r = validatePlanCoverage(p, source);
    expect(r.issues).toEqual([]);
    expect(r.verified).toBe(1);
  });

  it("accepts a quote with the status values written without backticks", () => {
    const p = plan(["db"], [{ requirement: "Status values are DRAFT, PUBLISHED, ARCHIVED.", task: 1, acceptance: "A1" }]);
    expect(validatePlanCoverage(p, source).issues).toEqual([]);
  });

  it("accepts a quote shortened with an ellipsis", () => {
    const p = plan(["api"], [{ requirement: "Require an authenticated ADMIN session ... every admin page and mutation.", task: 1, acceptance: "A1" }]);
    expect(validatePlanCoverage(p, source).verified).toBe(1);
  });

  it("drops an entry whose quote is not in the request and reports it, without discarding anything else", () => {
    const p = plan(["api"], [{ requirement: "Support cryptocurrency checkout", task: 1, acceptance: "A1" }]);
    const r = validatePlanCoverage(p, source);
    expect(p.coverage).toHaveLength(0);
    expect(r.verified).toBe(0);
    expect(r.issues.join("\n")).toContain("was not found in the request");
  });

  it("accepts a quote that reorders the request's own words, and an acceptance text that is worded a little differently", () => {
    const src = "Passwords are hashed with bcryptjs and the session lives in an httpOnly cookie.";
    const p = {
      goal: "g", assumptions: [], risks: [], questions: [],
      tasks: [{ role: "api", title: "t", instructions: "", acceptance: ["login test: wrong password refused, right one signed in"], scope: [], dependsOn: [] }],
      coverage: [{ requirement: "Password hashes with bcryptjs; session in an httpOnly cookie.", task: 1, acceptance: "login test wrong password is refused and the right one signed in" }],
    } as any;
    const r = validatePlanCoverage(p, src);
    expect(r.issues).toEqual([]);
    expect(r.verified).toBe(1);
  });

  it("still rejects a quote with too few of the request's words", () => {
    const p = plan(["api"], [{ requirement: "Support cryptocurrency checkout for admin pages", task: 1, acceptance: "A1" }]);
    expect(validatePlanCoverage(p, source).verified).toBe(0);
  });

  it("keeps one requirement that two tasks implement", () => {
    const quote = "Require an authenticated ADMIN session";
    const p = plan(["api", "design"], [
      { requirement: quote, task: 1, acceptance: "A1" },
      { requirement: quote, task: 2, acceptance: "A1" },
    ]);
    const r = validatePlanCoverage(p, source);
    expect(r.verified).toBe(2);
    expect(r.issues).toEqual([]);
  });

  it("asks for coverage of a feature task but not of infra, qa or debug tasks", () => {
    const p = plan(["api", "design", "infra", "qa"], [{ requirement: "Require an authenticated ADMIN session", task: 1, acceptance: "A1" }]);
    const r = validatePlanCoverage(p, source);
    expect(r.issues.some((i) => i.includes("task 2 (design)"))).toBe(true);
    expect(r.issues.some((i) => i.includes("task 3") || i.includes("task 4"))).toBe(false);
  });

  it("rejects an entry that points to a missing task or to an acceptance text that is not the task's", () => {
    const p = plan(["api"], [
      { requirement: "Require an authenticated ADMIN session", task: 5, acceptance: "A1" },
      { requirement: "Require an authenticated ADMIN session", task: 1, acceptance: "something else entirely" },
    ]);
    const r = validatePlanCoverage(p, source);
    expect(r.verified).toBe(0);
    expect(r.issues.join("\n")).toContain("missing task 5");
    expect(r.issues.join("\n")).toContain("does not match any criterion");
  });
});

describe("runTeam: planning", () => {
  const pmCalls = (f: ReturnType<typeof fakes>) => f.llmCalls.filter((c) => c.system.includes("Project Manager of a small"));

  it("asks the planner without the response cache, so a rejected plan is never replayed", async () => {
    const f = fakes();
    await run(f, "Build it");
    expect(pmCalls(f).length).toBeGreaterThan(0);
    for (const c of pmCalls(f)) expect(c.noCache).toBe(true);
  });

  it("repairs a rejected plan: the second request carries the rejected plan and the exact problem", async () => {
    let n = 0;
    const f = fakes({
      plan: (user) => {
        n++;
        const good = planFor(user);
        return n === 1 ? { ...good, coverage: [{ requirement: "text that is not in the request", task: 1, acceptance: good.tasks[0].acceptance[0] }] } : good;
      },
    });
    const res = await run(f, "Build the agreements app");
    expect(res).not.toBeNull();
    const pm = pmCalls(f);
    expect(pm).toHaveLength(2);
    expect(pm[1].user).toContain("<rejected_plan>");
    expect(pm[1].user).toContain("was not found in the request");
    expect(res!.plan.assumptions.join()).not.toContain("Traceability not fully verified");
  });

  it("uses the plan, with a warning, when the coverage map cannot be verified after every attempt", async () => {
    const f = fakes({
      plan: (user) => ({ ...planFor(user), coverage: [{ requirement: "text that is not in the request", task: 1, acceptance: "x" }] }),
    });
    const res = await run(f, "Build the agreements app");
    expect(res).not.toBeNull();
    expect(pmCalls(f)).toHaveLength(3);
    expect(res!.plan.assumptions.join()).toContain("Traceability not fully verified");
    expect(f.calls.some((c) => c.agent === "api")).toBe(true);
  });

  it("still fails (null, single-agent fallback) when the planner never returns usable JSON, and keeps the rejected answer", async () => {
    const f = fakes({ plan: () => "not json" });
    const res = await run(f, "Build the agreements app");
    expect(res).toBeNull();
    expect(fs.existsSync(path.join(ws, "tasks", "rejected-plan.json"))).toBe(true);
  });
});
