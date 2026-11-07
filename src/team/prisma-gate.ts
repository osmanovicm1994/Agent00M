// src/team/prisma-gate.ts
//
// A real run lost most of its time in one loop: the Prisma 7 generator `output` kept flipping between "../generated/prisma/client" and
// "../src/generated/prisma/client", the code imported "@/generated/prisma/client", and `tsc` said "Cannot find module" again and again.
// The cause is mechanical, not something a small model can reason out: the `prisma-client` generator writes client.ts INTO the output
// folder, so an output ending in "/client" produces .../client/client.ts and the import "@/generated/prisma/client" has no index file to find.
//
// This gate fixes it in code, with no model call: one output folder inside src (the "@/" alias reaches it), no stray copy elsewhere,
// imports that point at it, and `prisma generate` run once when anything changed. Safe to call again: with nothing to change it does nothing.

import * as fs from "fs";
import * as path from "path";
import { candidateAppDirs } from "./scaffold-gate";
import { shellRunner, tailOf, type Runner } from "./verify-gate";

export interface PrismaGateReport {
  /** Files changed or folders removed (relative to the workspace). */
  changed: string[];
  /** True when `prisma generate` ran and passed, false when it failed, null when it did not run. */
  generated: boolean | null;
  /** One short paragraph for the other agents; empty when nothing was wrong. */
  note: string;
}

export interface PrismaGateOptions {
  runner?: Runner;
  log?: (line: string) => void;
}

const SRC_EXT = /\.(ts|tsx|mts|cts)$/;
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "generated", "dist", "build", "coverage"]);

function read(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The app folder that has a Prisma 7 style schema (generator provider "prisma-client"), or null. */
export function findPrismaApp(root: string): string | null {
  for (const dir of candidateAppDirs(root)) {
    const schema = read(path.join(dir, "prisma", "schema.prisma"));
    if (/generator\s+\w+\s*\{[^}]*provider\s*=\s*"prisma-client"/s.test(schema)) return dir;
  }
  return null;
}

/** The output folder the schema should use: inside src/ when the app has one, so the "@/" alias reaches it. */
export function wantedOutput(appDir: string): { schemaValue: string; folder: string } {
  return isDir(path.join(appDir, "src"))
    ? { schemaValue: "../src/generated/prisma", folder: path.join(appDir, "src", "generated", "prisma") }
    : { schemaValue: "../generated/prisma", folder: path.join(appDir, "generated", "prisma") };
}

/** The schema text with the generator output set to `value` (added when missing). Returns the text unchanged when it already is. */
export function withOutput(schema: string, value: string): string {
  const block = /(generator\s+\w+\s*\{)([^}]*)(\})/s.exec(schema);
  if (!block || !/provider\s*=\s*"prisma-client"/.test(block[2])) return schema;
  let body = block[2];
  if (/output\s*=\s*"[^"]*"/.test(body)) body = body.replace(/output\s*=\s*"[^"]*"/, `output   = "${value}"`);
  else body = body.replace(/(provider\s*=\s*"prisma-client"[^\n]*\n)/, `$1  output   = "${value}"\n`);
  return schema.slice(0, block.index) + block[1] + body + block[3] + schema.slice(block.index + block[0].length);
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) sourceFiles(path.join(dir, e.name), out);
    } else if (SRC_EXT.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

/** The import specifier for the generated client, as seen from `file`. */
function clientSpecifier(file: string, appDir: string, folder: string): string {
  const inSrc = path.relative(path.join(appDir, "src"), file);
  if (!inSrc.startsWith("..") && !path.isAbsolute(inSrc)) return "@/generated/prisma/client";
  let rel = path.relative(path.dirname(file), path.join(folder, "client")).split(path.sep).join("/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

/** Rewrites imports of the generated client that cannot resolve. Returns the new text, or null when nothing needs to change. */
export function fixImports(text: string, specifier: string): string | null {
  let next = text;
  // "@prisma/client" has no PrismaClient export with the prisma-client generator.
  next = next.replace(/(from\s*["'])@prisma\/client(["'])/g, `$1${specifier}$2`);
  // ".../generated/prisma/client/client" and "../generated/prisma/client/<x>" came from an output that ended in "/client".
  next = next.replace(/(from\s*["'])((?:@\/|(?:\.\.?\/)+)(?:src\/)?generated\/prisma)\/client\/client(["'])/g, `$1${specifier}$3`);
  next = next.replace(/(from\s*["'])((?:\.\.?\/)+)(?:src\/)?generated\/prisma\/client(["'])/g, (_m, a, _b, c) => `${a}${specifier}${c}`);
  return next === text ? null : next;
}

/**
 * Makes the Prisma 7 client output consistent. Never throws.
 * Returns null when the project has no Prisma 7 style schema.
 */
export async function normalizePrismaOutput(root: string, opts: PrismaGateOptions = {}): Promise<PrismaGateReport | null> {
  if (process.env.AGENT_TEAM_PRISMA === "0") return null;
  const run = opts.runner ?? shellRunner;
  const log = opts.log ?? (() => {});
  const rel = (f: string): string => path.relative(root, f).split(path.sep).join("/");
  const changed: string[] = [];

  try {
    const appDir = findPrismaApp(root);
    if (!appDir) return null;
    const { schemaValue, folder } = wantedOutput(appDir);
    const schemaFile = path.join(appDir, "prisma", "schema.prisma");

    // 1. The schema's output.
    const schema = read(schemaFile);
    const fixedSchema = withOutput(schema, schemaValue);
    if (fixedSchema !== schema) {
      fs.writeFileSync(schemaFile, fixedSchema);
      changed.push(rel(schemaFile));
      log(`set the Prisma client output to ${schemaValue}`);
    }

    // 2. Stray copies: a generated client anywhere else is what the code imports by mistake.
    const strays = [path.join(appDir, "generated", "prisma"), path.join(appDir, "src", "generated", "prisma", "client")];
    for (const stray of strays) {
      if (path.resolve(stray) === path.resolve(folder)) continue;
      // Only a generated client is removed: the nested "client" folder holds client.ts, the outer one a schema or client files.
      const looksGenerated = fs.existsSync(path.join(stray, "client.ts")) || fs.existsSync(path.join(stray, "client", "client.ts")) || fs.existsSync(path.join(stray, "client", "client.js")) || fs.existsSync(path.join(stray, "client.js"));
      if (isDir(stray) && looksGenerated) {
        fs.rmSync(stray, { recursive: true, force: true });
        changed.push(`${rel(stray)}/ (removed)`);
        log(`removed the stray generated client ${rel(stray)}/`);
        const parent = path.dirname(stray);
        if (path.basename(parent) === "generated" && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
      }
    }

    // 3. Imports that cannot resolve.
    for (const file of sourceFiles(appDir)) {
      const text = read(file);
      if (!/@prisma\/client|generated\/prisma/.test(text)) continue;
      const next = fixImports(text, clientSpecifier(file, appDir, folder));
      if (next !== null) {
        fs.writeFileSync(file, next);
        changed.push(rel(file));
      }
    }

    // 4. Generate once when something changed or the client is missing.
    const present = fs.existsSync(path.join(folder, "client.ts"));
    let generated: boolean | null = null;
    let genNote = "";
    if (changed.length > 0 || !present) {
      const res = await run("npx prisma generate", appDir, 180_000);
      generated = res.exitCode === 0;
      if (!generated) genNote = ` \`npx prisma generate\` failed: ${tailOf(res.output, 500)}`;
    }

    if (changed.length === 0 && generated === null) return { changed, generated, note: "" };
    const importLine = `import { PrismaClient } from "@/generated/prisma/client"`;
    return {
      changed,
      generated,
      note:
        `Team (prisma): the Prisma client is generated into ${rel(folder)} (generator output "${schemaValue}") and is imported with \`${importLine}\`. ` +
        "Do not change `output` in schema.prisma, do not import from @prisma/client and do not generate into another folder." +
        (changed.length > 0 ? ` Fixed by the team: ${changed.slice(0, 6).join(", ")}${changed.length > 6 ? ", …" : ""}.` : "") +
        genNote,
    };
  } catch (err: any) {
    return { changed, generated: null, note: `the Prisma gate stopped unexpectedly: ${String(err?.message ?? err).slice(0, 300)}` };
  }
}
