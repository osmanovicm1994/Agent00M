import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findPrismaApp, fixImports, normalizePrismaOutput, withOutput } from "./prisma-gate";
import type { Runner } from "./verify-gate";

let root: string;

function put(rel: string, text: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const get = (rel: string): string => fs.readFileSync(path.join(root, rel), "utf8");

const schemaWith = (output: string): string =>
  `generator client {\n  provider = "prisma-client"\n${output ? `  output   = "${output}"\n` : ""}}\n\ndatasource db {\n  provider = "postgresql"\n}\n`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "prisma-gate-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function runner(calls: string[], exitCode = 0): Runner {
  return (command, cwd) => {
    calls.push(`${command} @ ${path.relative(root, cwd)}`);
    return { exitCode, timedOut: false, output: exitCode ? "boom" : "" };
  };
}

describe("withOutput", () => {
  it("replaces a wrong output and adds a missing one", () => {
    expect(withOutput(schemaWith("../generated/prisma/client"), "../src/generated/prisma")).toContain('output   = "../src/generated/prisma"');
    expect(withOutput(schemaWith(""), "../src/generated/prisma")).toContain('output   = "../src/generated/prisma"');
  });
  it("leaves a schema alone that already has the output, and the old prisma-client-js generator", () => {
    const ok = schemaWith("../src/generated/prisma");
    expect(withOutput(ok, "../src/generated/prisma")).toBe(ok);
    const old = 'generator client {\n  provider = "prisma-client-js"\n}\n';
    expect(withOutput(old, "../src/generated/prisma")).toBe(old);
  });
});

describe("fixImports", () => {
  it("rewrites @prisma/client and the doubled client path", () => {
    expect(fixImports('import { PrismaClient } from "@prisma/client";', "@/generated/prisma/client")).toBe('import { PrismaClient } from "@/generated/prisma/client";');
    expect(fixImports('import { Role } from "@/generated/prisma/client/client";', "@/generated/prisma/client")).toBe('import { Role } from "@/generated/prisma/client";');
  });
  it("returns null when nothing changes", () => {
    expect(fixImports('import { PrismaClient } from "@/generated/prisma/client";', "@/generated/prisma/client")).toBeNull();
  });
});

describe("normalizePrismaOutput", () => {
  it("returns null without a Prisma 7 style schema", async () => {
    expect(findPrismaApp(root)).toBeNull();
    expect(await normalizePrismaOutput(root, { runner: runner([]) })).toBeNull();
    put("apps/web/prisma/schema.prisma", 'generator client {\n  provider = "prisma-client-js"\n}\n');
    expect(await normalizePrismaOutput(root, { runner: runner([]) })).toBeNull();
  });

  it("fixes the flip-flop from the real run: wrong output, two generated copies, bad imports", async () => {
    put("apps/web/prisma/schema.prisma", schemaWith("../generated/prisma/client"));
    put("apps/web/src/lib/db.ts", 'import { PrismaClient } from "@prisma/client";\n');
    put("apps/web/prisma/seed.ts", 'import { PrismaClient } from "@prisma/client";\n');
    put("apps/web/generated/prisma/client/client.js", "x");
    put("apps/web/src/generated/prisma/client/client.ts", "x");
    fs.mkdirSync(path.join(root, "apps/web/src/app"), { recursive: true });
    const calls: string[] = [];

    const r = await normalizePrismaOutput(root, { runner: runner(calls) });

    expect(r?.generated).toBe(true);
    expect(get("apps/web/prisma/schema.prisma")).toContain('output   = "../src/generated/prisma"');
    expect(get("apps/web/src/lib/db.ts")).toContain('from "@/generated/prisma/client"');
    expect(get("apps/web/prisma/seed.ts")).toContain('from "../src/generated/prisma/client"');
    expect(fs.existsSync(path.join(root, "apps/web/generated"))).toBe(false);
    expect(fs.existsSync(path.join(root, "apps/web/src/generated/prisma/client"))).toBe(false);
    expect(calls).toEqual(["npx prisma generate @ apps/web"]);
    expect(r?.note).toContain("Do not change `output`");
  });

  it("does nothing, and does not run generate, when everything is already right", async () => {
    put("apps/web/prisma/schema.prisma", schemaWith("../src/generated/prisma"));
    put("apps/web/src/lib/db.ts", 'import { PrismaClient } from "@/generated/prisma/client";\n');
    put("apps/web/src/generated/prisma/client.ts", "x");
    const calls: string[] = [];
    const r = await normalizePrismaOutput(root, { runner: runner(calls) });
    expect(calls).toEqual([]);
    expect(r).toEqual({ changed: [], generated: null, note: "" });
  });

  it("generates when the client is missing, and reports a failing generate", async () => {
    put("apps/web/prisma/schema.prisma", schemaWith("../src/generated/prisma"));
    fs.mkdirSync(path.join(root, "apps/web/src"), { recursive: true });
    const r = await normalizePrismaOutput(root, { runner: runner([], 1) });
    expect(r?.generated).toBe(false);
    expect(r?.note).toContain("prisma generate");
  });

  it("is switched off with AGENT_TEAM_PRISMA=0", async () => {
    put("apps/web/prisma/schema.prisma", schemaWith("../wrong"));
    process.env.AGENT_TEAM_PRISMA = "0";
    try {
      expect(await normalizePrismaOutput(root, { runner: runner([]) })).toBeNull();
    } finally {
      delete process.env.AGENT_TEAM_PRISMA;
    }
  });
});
