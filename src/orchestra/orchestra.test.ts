import { describe, it, expect } from "vitest";
import { classifyFailure } from "./error-classifier";
import { WorkspaceLocks } from "./workspace-locks";
import { Blackboard } from "./blackboard";
import { DebugInterceptor, type DebugRequest } from "./debug-interceptor";
import { Semaphore, gateProvider } from "./llm-gate";
import { OrchestraMaster, type OrchTask, type TaskRunner } from "./orchestra-master";

const NPM_404 = `npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/@nestjs%2fnope - Not found
npm error 404
npm error 404  '@nestjs/nope@^1.0.0' is not in this registry.`;

describe("classifyFailure", () => {
  it("returns null for a successful command", () => {
    expect(classifyFailure("npm install", NPM_404, 0)).toBeNull();
  });
  it("recognises npm E404 as immediate and fixable", () => {
    const f = classifyFailure("npm install", NPM_404, 1);
    expect(f?.kind).toBe("npm-404");
    expect(f?.immediate).toBe(true);
    expect(f?.fixable).toBe(true);
    expect(f?.evidence).toContain("E404");
  });
  it("recognises ERESOLVE peer conflicts", () => {
    const f = classifyFailure("npm install", "npm error code ERESOLVE\nnpm error Could not resolve dependency:", 1);
    expect(f?.kind).toBe("npm-peer-conflict");
  });
  it("recognises a Prisma schema error", () => {
    const f = classifyFailure("npx prisma migrate dev", "Error validating model \"User\": ...", 1);
    expect(f?.kind).toBe("prisma-schema");
  });
  it("recognises a Prisma migration failure", () => {
    const f = classifyFailure("npx prisma migrate deploy", "Error: P3009\nmigrate found failed migrations", 1);
    expect(f?.kind).toBe("prisma-migration");
  });
  it("treats test failures as not immediate", () => {
    const f = classifyFailure("npm test", "Tests: 2 failed, 3 passed", 1);
    expect(f?.kind).toBe("test");
    expect(f?.immediate).toBe(false);
  });
  it("marks network problems as not fixable", () => {
    const f = classifyFailure("npm install", "getaddrinfo ENOTFOUND registry.npmjs.org", 1);
    expect(f?.fixable).toBe(false);
  });
  it("ignores weak signatures when the exit code is unknown", () => {
    expect(classifyFailure("npm test", "Tests: 2 failed", undefined)).toBeNull();
  });
  it("gives the same key for the same problem", () => {
    const a = classifyFailure("npm install", NPM_404, 1);
    const b = classifyFailure("npm i", NPM_404, 1);
    expect(a?.key).toBe(b?.key.replace("npm:", "npm:"));
  });
});

describe("WorkspaceLocks", () => {
  const root = "/ws";
  it("allows writes inside an agent's own scope", () => {
    const l = new WorkspaceLocks(root);
    l.tryAcquire("api", ["apps/api/"]);
    expect(l.canWrite("api", "/ws/apps/api/src/a.ts").allowed).toBe(true);
    expect(l.canWrite("api", "apps/api/src/a.ts").allowed).toBe(true);
  });
  it("refuses writes in another agent's scope and outside any scope", () => {
    const l = new WorkspaceLocks(root);
    l.tryAcquire("api", ["apps/api/"]);
    l.tryAcquire("web", ["apps/web/"]);
    expect(l.canWrite("api", "apps/web/page.tsx").allowed).toBe(false);
    expect(l.canWrite("api", "docs/x.md").allowed).toBe(false);
  });
  it("refuses shared root files and paths outside the workspace", () => {
    const l = new WorkspaceLocks(root);
    l.tryAcquire("api", ["apps/api/", "package.json"]);
    expect(l.canWrite("api", "package-lock.json").allowed).toBe(false);
    expect(l.canWrite("api", "../etc/passwd").allowed).toBe(false);
  });
  it("refuses overlapping leases", () => {
    const l = new WorkspaceLocks(root);
    expect(l.tryAcquire("a", ["apps/api/"]).ok).toBe(true);
    const r = l.tryAcquire("b", ["apps/api/src/"]);
    expect(r.ok).toBe(false);
    l.release("a");
    expect(l.tryAcquire("b", ["apps/api/src/"]).ok).toBe(true);
  });
  it("does not restrict unmanaged owners", () => {
    const l = new WorkspaceLocks(root);
    l.tryAcquire("api", ["apps/api/"]);
    expect(l.canWrite("supervisor", "apps/api/x.ts").allowed).toBe(true);
  });
  it("does not confuse apps/api with apps/api-gateway", () => {
    const l = new WorkspaceLocks(root);
    l.tryAcquire("a", ["apps/api/"]);
    expect(l.tryAcquire("b", ["apps/api-gateway/"]).ok).toBe(true);
  });
});

describe("Blackboard", () => {
  it("shows an agent only what the others did, once", () => {
    const b = new Blackboard();
    b.post("db", "file-written", "schema done", "prisma/schema.prisma");
    b.post("api", "file-written", "mine");
    const d = b.digestFor("api");
    expect(d).toContain("[db]");
    expect(d).not.toContain("mine");
    expect(b.digestFor("api")).toBe("");
  });
  it("versions contracts", () => {
    const b = new Blackboard();
    expect(b.setContract("schema", "db", "v1").version).toBe(1);
    expect(b.setContract("schema", "db", "v2").version).toBe(2);
    expect(b.contractsText(["schema"])).toContain("v2");
  });
});

describe("DebugInterceptor", () => {
  const cfg = { enabled: true, maxPerRun: 3, maxPerKey: 1, escalateAfter: 2 };
  const ev = (output: string, agentId = "api", command = "npm install") => ({ agentId, command, output, exitCode: 1 });

  it("does nothing when disabled", async () => {
    const i = new DebugInterceptor({ debug: async () => ({ patched: true, summary: "", filesChanged: [] }) }, { ...cfg, enabled: false });
    expect(await i.handle(ev(NPM_404))).toBeNull();
  });
  it("runs the debug agent with the exact output and reports a verified fix", async () => {
    let seen: DebugRequest | undefined;
    const i = new DebugInterceptor(
      {
        debug: async (req) => {
          seen = req;
          return { patched: true, summary: "pinned @nestjs/core to 10.4.0", filesChanged: ["apps/api/package.json"] };
        },
        rerun: async () => ({ output: "ok", exitCode: 0 }),
      },
      cfg,
    );
    const note = await i.handle(ev(NPM_404));
    expect(seen?.output).toContain("is not in this registry");
    expect(note).toContain("FIXED and verified");
    expect(note).toContain("apps/api/package.json");
  });
  it("reports when the patch did not fix it", async () => {
    const i = new DebugInterceptor(
      { debug: async () => ({ patched: true, summary: "tried", filesChanged: [] }), rerun: async () => ({ output: "still bad", exitCode: 1 }) },
      cfg,
    );
    expect(await i.handle(ev(NPM_404))).toContain("still fails");
  });
  it("shares one debug run between parallel agents with the same failure", async () => {
    let calls = 0;
    const i = new DebugInterceptor(
      {
        debug: async () => {
          calls++;
          await new Promise((r) => setTimeout(r, 20));
          return { patched: true, summary: "fixed", filesChanged: [] };
        },
      },
      cfg,
    );
    const [a, b] = await Promise.all([i.handle(ev(NPM_404, "api")), i.handle(ev(NPM_404, "web"))]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });
  it("waits for a noisy failure to repeat before debugging", async () => {
    let calls = 0;
    const i = new DebugInterceptor({ debug: async () => (calls++, { patched: false, summary: "none", filesChanged: [] }) }, cfg);
    expect(await i.handle(ev("Tests: 1 failed", "qa", "npm test"))).toBeNull();
    expect(calls).toBe(0);
    expect(await i.handle(ev("Tests: 1 failed", "qa", "npm test"))).toContain("no safe patch");
    expect(calls).toBe(1);
  });
  it("respects the total budget and never throws", async () => {
    const i = new DebugInterceptor({ debug: async () => { throw new Error("model down"); } }, { ...cfg, maxPerRun: 1 });
    expect(await i.handle(ev(NPM_404))).toContain("could not run");
    expect(await i.handle(ev("npm error code ERESOLVE"))).toBeNull();
  });
  it("only notes non-fixable failures once", async () => {
    const i = new DebugInterceptor({ debug: async () => ({ patched: true, summary: "", filesChanged: [] }) }, cfg);
    const out = "getaddrinfo ENOTFOUND registry.npmjs.org";
    expect(await i.handle(ev(out))).toContain("AUTO-DEBUG NOTE");
    expect(await i.handle(ev(out))).toBeNull();
  });
});

describe("Semaphore and gateProvider", () => {
  it("never exceeds the limit", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let max = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        sem.run(async () => {
          active++;
          max = Math.max(max, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(max).toBe(2);
    expect(sem.inFlight).toBe(0);
  });
  it("gates chat but passes other members through", async () => {
    const sem = new Semaphore(1);
    let active = 0;
    let max = 0;
    const provider = {
      name: "x",
      async chat() {
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return "ok";
      },
    };
    const g = gateProvider(provider, sem);
    await Promise.all([g.chat(), g.chat(), g.chat()]);
    expect(max).toBe(1);
    expect(g.name).toBe("x");
  });
});

describe("OrchestraMaster", () => {
  const t = (id: string, scope: string[], dependsOn: string[] = []): OrchTask => ({ id, agent: id, title: id, instructions: "", scope, dependsOn });
  const ok = (summary = "done") => ({ status: "done" as const, summary, filesWritten: [], commandsRun: [] });

  it("validates cycles, unknown deps and overlapping parallel scopes", () => {
    expect(OrchestraMaster.validate([t("a", ["x/"], ["b"]), t("b", ["y/"], ["a"])]).join()).toContain("cycle");
    expect(OrchestraMaster.validate([t("a", ["x/"], ["zz"])]).join()).toContain("unknown");
    expect(OrchestraMaster.validate([t("a", ["apps/"]), t("b", ["apps/api/"])]).join()).toContain("parallel");
    expect(OrchestraMaster.validate([t("a", ["apps/"]), t("b", ["apps/api/"], ["a"])])).toEqual([]);
  });

  it("runs independent tasks concurrently and respects dependencies", async () => {
    const events: string[] = [];
    let active = 0;
    let max = 0;
    const runner: TaskRunner = async (task) => {
      events.push("start:" + task.id);
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      events.push("end:" + task.id);
      return task.id === "db" ? { ...ok(), contract: { name: "schema", body: "User(id)" } } : ok();
    };
    const m = new OrchestraMaster({ runner, locks: new WorkspaceLocks("/ws"), concurrency: 3 });
    const res = await m.run([t("db", ["prisma/"]), t("api", ["apps/api/"], ["db"]), t("web", ["apps/web/"], ["db"])]);
    expect(res.ok).toBe(true);
    expect(max).toBe(2); // api and web overlap, db ran alone first
    expect(events.indexOf("end:db")).toBeLessThan(events.indexOf("start:api"));
    expect(events.indexOf("end:db")).toBeLessThan(events.indexOf("start:web"));
    expect(m.board.getContract("schema")?.owner).toBe("db");
  });

  it("gives dependent tasks the contract text", async () => {
    let seen = "";
    const runner: TaskRunner = async (task, ctx) => {
      if (task.id === "api") seen = ctx.contractsText;
      return task.id === "db" ? { ...ok(), contract: { name: "schema", body: "User(id)" } } : ok();
    };
    const m = new OrchestraMaster({ runner, locks: new WorkspaceLocks("/ws") });
    await m.run([t("db", ["prisma/"]), { ...t("api", ["apps/api/"], ["db"]), readsContracts: ["schema"] }]);
    expect(seen).toContain("User(id)");
  });

  it("skips dependents of a failed task but runs independent ones", async () => {
    const runner: TaskRunner = async (task) => (task.id === "db" ? { status: "failed", summary: "boom", filesWritten: [], commandsRun: [] } : ok());
    const m = new OrchestraMaster({ runner, locks: new WorkspaceLocks("/ws") });
    const res = await m.run([t("db", ["prisma/"]), t("api", ["apps/api/"], ["db"]), t("docs", ["docs/"])]);
    expect(res.outcomes.api.status).toBe("skipped");
    expect(res.outcomes.docs.status).toBe("done");
    expect(res.ok).toBe(false);
  });

  it("turns a crashing runner into a failed outcome", async () => {
    const runner: TaskRunner = async () => {
      throw new Error("kaboom");
    };
    const m = new OrchestraMaster({ runner, locks: new WorkspaceLocks("/ws") });
    const res = await m.run([t("a", ["a/"])]);
    expect(res.outcomes.a.status).toBe("failed");
    expect(res.outcomes.a.summary).toContain("kaboom");
  });

  it("failFast skips what has not started", async () => {
    const runner: TaskRunner = async (task) => (task.id === "a" ? { status: "failed", summary: "x", filesWritten: [], commandsRun: [] } : ok());
    const m = new OrchestraMaster({ runner, locks: new WorkspaceLocks("/ws"), concurrency: 1, failFast: true });
    const res = await m.run([t("a", ["a/"]), t("b", ["b/"])]);
    expect(res.outcomes.b.status).toBe("skipped");
  });

  it("rejects an invalid plan", async () => {
    const m = new OrchestraMaster({ runner: async () => ok(), locks: new WorkspaceLocks("/ws") });
    await expect(m.run([t("a", ["apps/"]), t("b", ["apps/"])])).rejects.toThrow("Invalid orchestra plan");
  });
});
