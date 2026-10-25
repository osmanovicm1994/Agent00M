import { describe, expect, it } from "vitest";
import { StallGuard, classifyCall, commandFamily, isInspectCommand, stallGuardEnabled, stallOptionsFor, type StallEvent } from "./stall-guard";

const look = (family: string): StallEvent => ({ kind: "inspect", family });
const act = (family: string): StallEvent => ({ kind: "command", family });
const write = (family = "write:a.ts"): StallEvent => ({ kind: "write", family });

describe("commandFamily", () => {
  it("treats different paths inside node_modules as one family", () => {
    expect(commandFamily("ls node_modules/@prisma/client")).toBe("ls node_modules");
    expect(commandFamily("ls -la node_modules/prisma 2>&1 | head -5")).toBe("ls node_modules");
  });

  it("keeps the subcommand and package of package-manager commands", () => {
    expect(commandFamily("npm install zod --save")).toBe("npm install zod");
    expect(commandFamily("npx prisma generate")).toBe("npx prisma generate");
    expect(commandFamily("cd web && npm run build")).toBe("cd web && npm run build");
  });

  it("uses the path, not the pattern, for grep", () => {
    expect(commandFamily("grep -rn foo src/lib")).toBe("grep src/lib");
  });
});

describe("isInspectCommand", () => {
  it("accepts commands that only look", () => {
    for (const c of ["ls node_modules/x", "cat package.json", "git status", "git log -n 5", "npm view next version", "node -v", "ls a && cat b", "find . -name x.ts"]) {
      expect(isInspectCommand(c), c).toBe(true);
    }
  });

  it("rejects commands that change something", () => {
    for (const c of ["npm install zod", "npm run build", "echo hi > a.txt", "sed -i s/a/b/ f", "find . -delete", "rm -v x", "git commit -m x", "ls && npm test", "mkdir -p src"]) {
      expect(isInspectCommand(c), c).toBe(false);
    }
  });

  it("allows output thrown away", () => {
    expect(isInspectCommand("ls missing 2>/dev/null")).toBe(true);
    expect(isInspectCommand("ls missing 2>&1")).toBe(true);
  });
});

describe("classifyCall", () => {
  it("counts a successful write as a change and a failed one as nothing", () => {
    expect(classifyCall("write_file", '{"path":"a.ts"}', "File written: a.ts")?.kind).toBe("write");
    expect(classifyCall("append_file", '{"path":"a.ts"}', "File appended: a.ts")?.kind).toBe("write");
    expect(classifyCall("write_file", '{"path":"a.ts"}', "TOOL ERROR: nope")).toBeNull();
  });

  it("separates looking from doing", () => {
    expect(classifyCall("read_file", '{"path":"a.ts"}', "x")).toEqual({ kind: "inspect", family: "read_file:a.ts:-" });
    expect(classifyCall("read_file", '{"path":"a.ts","start_line":1,"end_line":200}', "x")?.family).toBe("read_file:a.ts:1-200");
    expect(classifyCall("run_command", '{"command":"ls node_modules/a"}', "")?.kind).toBe("inspect");
    expect(classifyCall("run_command", '{"command":"npm install"}', "")?.kind).toBe("command");
  });

  it("ignores tools that say nothing about circling and bad JSON", () => {
    expect(classifyCall("web_search", '{"query":"x"}', "")).toBeNull();
    expect(classifyCall("update_plan", "{}", "")).toBeNull();
    expect(classifyCall("run_command", "not json", "")).toBeNull();
  });
});

describe("StallGuard loop check", () => {
  it("warns on an A,B,A,B,A,B pattern, warns again, then stops", () => {
    const g = new StallGuard();
    const levels: string[] = [];
    for (let i = 0; i < 10; i++) levels.push(g.record(look(i % 2 ? "ls node_modules" : "ls dist")).level);
    expect(levels).toEqual(["ok", "ok", "ok", "ok", "ok", "warn", "ok", "warn", "ok", "stop"]);
  });

  it("gives the person a plain-language stop text", () => {
    const g = new StallGuard();
    let last;
    for (let i = 0; i < 10; i++) last = g.record(look(i % 2 ? "b" : "a"));
    expect(last?.message).toMatch(/going in circles/);
    expect(last?.message).toMatch(/What to do/);
  });

  it("does not treat reading one long file in chunks as a loop", () => {
    const g = new StallGuard();
    for (let i = 0; i < 12; i++) {
      const ev = classifyCall("read_file", JSON.stringify({ path: "big.ts", start_line: i * 200 + 1, end_line: (i + 1) * 200 }), "x")!;
      expect(g.record(ev).level).toBe("ok");
    }
  });

  it("does not fire when three or more different things are looked at", () => {
    const g = new StallGuard();
    const fams = ["a", "b", "c"];
    for (let i = 0; i < 30; i++) expect(g.record(look(fams[i % 3])).level).toBe("ok");
  });

  it("resets when a file is written", () => {
    const g = new StallGuard();
    for (let i = 0; i < 8; i++) g.record(look(i % 2 ? "b" : "a"));
    g.record(write());
    const levels: string[] = [];
    for (let i = 0; i < 6; i++) levels.push(g.record(act(i % 2 ? "npm run build" : "npm install")).level);
    expect(levels).toEqual(["ok", "ok", "ok", "ok", "ok", "warn"]);
  });

  it("stops the same rule for repeated identical commands too", () => {
    const g = new StallGuard();
    const levels: string[] = [];
    for (let i = 0; i < 10; i++) levels.push(g.record(act("npm run build")).level);
    expect(levels[5]).toBe("warn");
    expect(levels[9]).toBe("stop");
  });
});

describe("StallGuard spiral check", () => {
  const options = { inspectWarn: 3, inspectStop: 5 };

  it("warns once at the warn threshold and stops at the stop threshold", () => {
    const g = new StallGuard(options);
    const levels = ["a", "b", "c", "d", "e"].map((f) => g.record(look(f)).level);
    expect(levels).toEqual(["ok", "ok", "warn", "ok", "stop"]);
  });

  it("is off by default", () => {
    const g = new StallGuard();
    for (const f of ["a", "b", "c", "d", "e", "f", "g", "h"]) expect(g.record(look(f)).level).toBe("ok");
  });

  it("a command that changes state restarts the count", () => {
    const g = new StallGuard(options);
    g.record(look("a"));
    g.record(look("b"));
    g.record(act("npm install zod"));
    expect(g.record(look("c")).level).toBe("ok");
    expect(g.record(look("d")).level).toBe("ok");
  });

  it("a write restarts the count", () => {
    const g = new StallGuard(options);
    g.record(look("a"));
    g.record(look("b"));
    g.record(write());
    expect(g.record(look("c")).level).toBe("ok");
    expect(g.record(look("d")).level).toBe("ok");
  });
});

describe("configuration", () => {
  it("gives only the debug agent the spiral check", () => {
    expect(stallOptionsFor("debug", {})).toEqual({ inspectWarn: 6, inspectStop: 10 });
    expect(stallOptionsFor("frontend", {})).toEqual({});
  });

  it("can be tuned and switched off", () => {
    expect(stallOptionsFor("debug", { AGENT_DEBUG_INSPECT_WARN: "4", AGENT_DEBUG_INSPECT_STOP: "7" })).toEqual({ inspectWarn: 4, inspectStop: 7 });
    expect(stallGuardEnabled({ AGENT_STALL_GUARD: "0" })).toBe(false);
    expect(stallGuardEnabled({})).toBe(true);
  });
});
