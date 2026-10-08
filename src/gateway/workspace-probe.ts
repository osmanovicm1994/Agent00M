// src/gateway/workspace-probe.ts
//
// Builds a SMALL fingerprint of the target project for the triage model: which stacks are
// present and where, which scripts exist, which runtime versions are pinned, and the top-level
// folder names. It reads marker files only; no source code and no .env files leave the machine.

import * as fs from "fs";
import * as path from "path";

export type StackKind =
  | "ios"
  | "android"
  | "nestjs-api"
  | "nextjs-web"
  | "node-monorepo-root"
  | "database"
  | "playwright"
  | "appium"
  | "dotnet"
  | "python"
  | "docker";

export interface StackSignal {
  kind: StackKind;
  /** Relative to the project root, "." for the root itself. */
  path: string;
  /** The marker that proved it, e.g. "@nestjs/core in package.json". */
  evidence: string;
}

export interface WorkspaceFingerprint {
  signals: StackSignal[];
  /** package.json folder -> { script name: command } for the scripts that matter. */
  scripts: Record<string, Record<string, string>>;
  /** Pinned versions: node, packageManager, java, gradle, swift, dotnet ... */
  runtime: Record<string, string>;
  /** Top-level entries; folders end with "/". */
  tree: string[];
  notes: string[];
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".nx",
  ".cache",
  ".gradle",
  ".idea",
  ".vscode",
  "Pods",
  "DerivedData",
  "bin",
  "obj",
  "venv",
  ".venv",
  "__pycache__",
  "coverage",
  ".agent_cache",
]);

// Folders whose children are usually packages, apps or platform projects.
const CONTAINERS = ["apps", "packages", "services", "libs", "mobile", "clients", "e2e", "tests", "src"];

const MAX_DIRS = 80;
const MAX_SCRIPTS_PER_PACKAGE = 14;

// Scripts that tell the agent how things are started, built and tested.
const SCRIPT_NAME_RE = /^(dev|start|build|test|lint|typecheck|check|e2e|ci|serve|watch|migrate|seed|generate|db|prisma|docker)(:.+)?$|^(dev|start|build|test|e2e|db|migrate|lint):.+$/;

function readText(file: string, max = 40_000): string {
  try {
    return fs.readFileSync(file, "utf8").slice(0, max);
  } catch {
    return "";
  }
}

function firstLine(file: string): string {
  return (
    readText(file, 400)
      .split(/\r?\n/)
      .find((l) => l.trim())
      ?.trim()
      .slice(0, 100) ?? ""
  );
}

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function childDirs(base: string): string[] {
  return listDir(base)
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
    .map((e) => path.join(base, e.name));
}

/** The root, its children, and the children of apps/, packages/, ... (bounded). */
function candidateDirs(root: string): string[] {
  const dirs: string[] = [root];
  const add = (d: string) => {
    if (!dirs.includes(d)) dirs.push(d);
  };
  for (const d of childDirs(root)) add(d);
  for (const c of CONTAINERS) for (const d of childDirs(path.join(root, c))) add(d);
  return dirs.slice(0, MAX_DIRS);
}

export function probeWorkspace(rootInput: string): WorkspaceFingerprint {
  const root = path.resolve(rootInput);
  const fp: WorkspaceFingerprint = { signals: [], scripts: {}, runtime: {}, tree: [], notes: [] };
  const seen = new Set<string>();

  const rel = (d: string): string => path.relative(root, d).replace(/\\/g, "/") || ".";
  const add = (kind: StackKind, dir: string, evidence: string) => {
    const key = `${kind}@${rel(dir)}`;
    if (seen.has(key)) return;
    seen.add(key);
    fp.signals.push({ kind, path: rel(dir), evidence });
  };

  for (const dir of candidateDirs(root)) {
    const entries = listDir(dir);
    const names = new Set(entries.map((e) => e.name));
    const has = (n: string) => names.has(n);
    const find = (re: RegExp) => entries.find((e) => re.test(e.name))?.name;

    // ---- iOS ---------------------------------------------------------------------------
    const xcode = find(/\.(xcodeproj|xcworkspace)$/);
    if (xcode) add("ios", dir, xcode);
    else if (has("Package.swift")) add("ios", dir, "Package.swift");
    if (has("Podfile")) add("ios", dir, "Podfile");

    // ---- Android -----------------------------------------------------------------------
    const gradleFiles = ["build.gradle.kts", "build.gradle", "settings.gradle.kts", "settings.gradle"].filter(has);
    if (gradleFiles.length) {
      // A root Gradle project often has no Android plugin line itself; its app module has the manifest.
      const manifest =
        fs.existsSync(path.join(dir, "app", "src", "main", "AndroidManifest.xml")) ||
        fs.existsSync(path.join(dir, "src", "main", "AndroidManifest.xml"));
      const androidBuildFile = gradleFiles.find(
        (g) => g.startsWith("build.") && /com\.android|android\s*\{/.test(readText(path.join(dir, g), 20_000)),
      );
      if (manifest) add("android", dir, "AndroidManifest.xml");
      else if (androidBuildFile) add("android", dir, androidBuildFile);
    }
    const wrapper = path.join(dir, "gradle", "wrapper", "gradle-wrapper.properties");
    if (fs.existsSync(wrapper)) {
      const m = readText(wrapper, 2_000).match(/gradle-([\d.]+)-/);
      if (m) fp.runtime.gradle = m[1];
    }

    // ---- Node / TypeScript -------------------------------------------------------------
    if (has("package.json")) {
      try {
        const pkg = JSON.parse(readText(path.join(dir, "package.json"), 200_000));
        const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
        const hasDep = (...names: string[]) => names.find((n) => n in deps);

        const nest = hasDep("@nestjs/core", "@nestjs/common");
        if (nest) add("nestjs-api", dir, `${nest} in package.json`);
        if (has("nest-cli.json")) add("nestjs-api", dir, "nest-cli.json");

        const next = hasDep("next");
        if (next) add("nextjs-web", dir, "next in package.json");

        const pw = hasDep("@playwright/test", "playwright");
        if (pw) add("playwright", dir, `${pw} in package.json`);

        const appium = hasDep("appium", "@wdio/appium-service", "appium-webdriverio", "webdriverio", "wd");
        if (appium && (hasDep("appium", "@wdio/appium-service") || find(/^wdio\.conf\./))) {
          add("appium", dir, `${hasDep("appium", "@wdio/appium-service") ?? appium} in package.json`);
        }

        const db = hasDep("prisma", "@prisma/client", "typeorm", "@mikro-orm/core", "sequelize", "drizzle-orm", "knex");
        if (db) add("database", dir, `${db} in package.json`);

        if (pkg.workspaces || has("pnpm-workspace.yaml") || has("turbo.json") || has("nx.json") || has("lerna.json")) {
          const marker = has("turbo.json") ? "turbo.json" : has("nx.json") ? "nx.json" : has("pnpm-workspace.yaml") ? "pnpm-workspace.yaml" : "workspaces in package.json";
          add("node-monorepo-root", dir, marker);
        }

        if (typeof pkg.packageManager === "string" && !fp.runtime.packageManager) fp.runtime.packageManager = pkg.packageManager;
        if (pkg.engines?.node && !fp.runtime.nodeEngine) fp.runtime.nodeEngine = String(pkg.engines.node);

        const scripts: Record<string, string> = {};
        for (const [name, cmd] of Object.entries<any>(pkg.scripts ?? {})) {
          if (typeof cmd !== "string" || !SCRIPT_NAME_RE.test(name)) continue;
          if (Object.keys(scripts).length >= MAX_SCRIPTS_PER_PACKAGE) break;
          scripts[name] = cmd.length > 110 ? `${cmd.slice(0, 110)}…` : cmd;
        }
        if (Object.keys(scripts).length) fp.scripts[rel(dir)] = scripts;
      } catch {
        fp.notes.push(`unreadable package.json in ${rel(dir)}`);
      }
    }

    if (has("prisma") && fs.existsSync(path.join(dir, "prisma", "schema.prisma"))) add("database", dir, "prisma/schema.prisma");

    // ---- Test automation config files --------------------------------------------------
    const pwConfig = find(/^playwright\.config\.(ts|js|mjs|cjs)$/);
    if (pwConfig) add("playwright", dir, pwConfig);
    const wdio = find(/^wdio\.conf\./);
    if (wdio) add("appium", dir, wdio);

    // ---- .NET (C# Appium / Playwright suites, backends) --------------------------------
    const csproj = find(/\.csproj$/);
    if (csproj) {
      const content = readText(path.join(dir, csproj), 20_000);
      if (/Appium\.WebDriver/i.test(content)) add("appium", dir, `Appium.WebDriver in ${csproj}`);
      else if (/Microsoft\.Playwright/i.test(content)) add("playwright", dir, `Microsoft.Playwright in ${csproj}`);
      else add("dotnet", dir, csproj);
    } else if (find(/\.sln$/)) {
      add("dotnet", dir, find(/\.sln$/)!);
    }

    // ---- Python ------------------------------------------------------------------------
    for (const f of ["requirements.txt", "pyproject.toml"]) {
      if (!has(f)) continue;
      const content = readText(path.join(dir, f), 20_000);
      if (/Appium-Python-Client/i.test(content)) add("appium", dir, `Appium-Python-Client in ${f}`);
      else add("python", dir, f);
    }

    // ---- Containers --------------------------------------------------------------------
    if (find(/^(Dockerfile|docker-compose.*\.ya?ml|compose\.ya?ml)$/)) add("docker", dir, find(/^(Dockerfile|docker-compose.*\.ya?ml|compose\.ya?ml)$/)!);

    // ---- Pinned runtime versions (first match wins) --------------------------------------
    const pins: Array<[string, string]> = [
      [".nvmrc", "node"],
      [".node-version", "node"],
      [".java-version", "java"],
      [".swift-version", "swift"],
      [".ruby-version", "ruby"],
      [".python-version", "python"],
    ];
    for (const [file, key] of pins) {
      if (has(file) && !fp.runtime[key]) fp.runtime[key] = firstLine(path.join(dir, file));
    }
    if (has(".tool-versions") && !fp.runtime.toolVersions) {
      fp.runtime.toolVersions = readText(path.join(dir, ".tool-versions"), 600).split(/\r?\n/).filter(Boolean).slice(0, 6).join("; ");
    }
    if (has("global.json") && !fp.runtime.dotnetSdk) {
      const m = readText(path.join(dir, "global.json"), 2_000).match(/"version"\s*:\s*"([^"]+)"/);
      if (m) fp.runtime.dotnetSdk = m[1];
    }
  }

  // ---- Project-level notes ---------------------------------------------------------------
  const rootNames = new Set(listDir(root).map((e) => e.name));
  const lock = ["pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lockb", "Podfile.lock", "Package.resolved"].filter((l) => rootNames.has(l));
  if (lock.length) fp.notes.push(`lockfiles at root: ${lock.join(", ")}`);
  fp.notes.push(rootNames.has(".git") ? "git repository" : "not a git repository");
  if (rootNames.has(".env.example")) fp.notes.push(".env.example present (real .env files are never read)");
  if (rootNames.has("node_modules")) fp.notes.push("node_modules present at root");

  fp.tree = listDir(root)
    .filter((e) => !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort()
    .slice(0, 40);

  return fp;
}

/** JSON for the prompt, shrunk until it fits `maxChars` (least useful parts go first). */
export function fingerprintToJson(fp: WorkspaceFingerprint, maxChars = 6000): string {
  const copy: WorkspaceFingerprint = JSON.parse(JSON.stringify(fp));
  let json = JSON.stringify(copy);
  const shrinkers: Array<() => void> = [
    () => (copy.tree = copy.tree.slice(0, 20)),
    () => {
      for (const k of Object.keys(copy.scripts)) copy.scripts[k] = Object.fromEntries(Object.entries(copy.scripts[k]).slice(0, 8));
    },
    () => (copy.signals = copy.signals.slice(0, 30)),
    () => (copy.tree = []),
    () => (copy.scripts = Object.fromEntries(Object.entries(copy.scripts).slice(0, 6))),
    () => (copy.signals = copy.signals.slice(0, 15)),
  ];
  for (const shrink of shrinkers) {
    if (json.length <= maxChars) break;
    shrink();
    json = JSON.stringify(copy);
  }
  return json.length > maxChars ? json.slice(0, maxChars) : json;
}
