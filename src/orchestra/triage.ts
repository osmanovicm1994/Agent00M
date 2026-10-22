// src/orchestra/triage.ts
//
// The hand-off when automatic debugging is exhausted: after N failed attempts on the same command the run stops
// (no N+1th try) and the user gets ONE report in a fixed format, instead of a model that keeps looping.
//
// Pure helpers + a small project probe (file names only). No model calls.

import * as fs from "fs";
import * as path from "path";
import type { Failure } from "./error-classifier";

export interface AttemptRecord {
  n: number;
  /** What the Debug Agent said it did or found (one line). */
  summary: string;
  filesChanged: string[];
  /** no-patch: it found nothing safe to change. still-fails: patched, command still fails. unverified: patched, not re-run. */
  outcome: "no-patch" | "still-fails" | "unverified";
}

export interface ProjectFacts {
  stack: string;
  dirs: string[];
}

export interface TriageInput {
  project: ProjectFacts;
  command: string;
  output: string;
  failure: Failure;
  attempts: AttemptRecord[];
  limit: number;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", ".turbo", ".agent_cache", "Pods", "DerivedData", ".venv", "venv", "__pycache__", "coverage"]);

/** What stack the folder looks like, and which folders were looked at. Names only; never file contents beyond package.json deps. */
export function describeProject(root: string): ProjectFacts {
  const found: string[] = [];
  const has = (...names: string[]) => names.some((n) => fs.existsSync(path.join(root, n)));
  const dirs: string[] = ["."];

  let top: fs.Dirent[] = [];
  try {
    top = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // unreadable folder: report what we know
  }
  for (const d of top) {
    if (!d.isDirectory() || SKIP_DIRS.has(d.name) || d.name.startsWith(".")) continue;
    dirs.push(`${d.name}/`);
    if (d.name === "apps" || d.name === "packages" || d.name === "services") {
      try {
        for (const sub of fs.readdirSync(path.join(root, d.name), { withFileTypes: true })) {
          if (sub.isDirectory() && !SKIP_DIRS.has(sub.name)) dirs.push(`${d.name}/${sub.name}/`);
        }
      } catch {
        // ignore
      }
    }
  }

  const manifests = [path.join(root, "package.json"), ...dirs.filter((d) => d.includes("/")).map((d) => path.join(root, d, "package.json"))];
  const deps = new Set<string>();
  for (const file of manifests) {
    try {
      const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const k of Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })) deps.add(k);
    } catch {
      // missing or invalid manifest
    }
  }
  const dep = (n: string) => deps.has(n);
  if (dep("next")) found.push("Next.js");
  if (dep("@nestjs/core")) found.push("NestJS");
  if (dep("react") && !dep("next")) found.push("React");
  if (dep("vite")) found.push("Vite");
  if (dep("express")) found.push("Express");
  if (dep("prisma") || dep("@prisma/client")) found.push("Prisma");
  if (dep("tailwindcss")) found.push("Tailwind");
  if (dep("react-native")) found.push("React Native");
  if (dep("typescript")) found.push("TypeScript");
  if (has("pubspec.yaml")) found.push("Flutter");
  if (has("Package.swift", "project.yml") || top.some((d) => d.name.endsWith(".xcodeproj") || d.name.endsWith(".xcworkspace"))) found.push("iOS (Swift)");
  if (has("build.gradle", "build.gradle.kts", "gradlew")) found.push("Android/Gradle");
  if (has("go.mod")) found.push("Go");
  if (has("Cargo.toml")) found.push("Rust");
  if (has("requirements.txt", "pyproject.toml")) found.push("Python");
  if (has("docker-compose.yml", "docker-compose.yaml", "compose.yaml") || has("Dockerfile")) found.push("Docker");
  return { stack: found.length ? found.join(", ") : "not detected (no known manifest found)", dirs };
}

// Up to two direct questions, chosen by what kind of failure it was.
function interventions(failure: Failure, command: string): string[] {
  switch (failure.kind) {
    case "npm-404":
    case "npm-version-missing":
      return [
        "Which exact package name and version should the project use for the failing dependency, and is the npm registry (or your private registry) reachable from this machine with the right credentials?",
      ];
    case "npm-peer-conflict":
      return ["Which major version of the framework must the project stay on, so the other packages can be aligned to it?"];
    case "prisma-schema":
    case "prisma-migration":
    case "prisma-client":
      return [
        "Which Prisma version and database (provider and a reachable DATABASE_URL in the app's .env) should be used?",
        "May the development database be reset if a migration has to be rebuilt from scratch?",
      ];
    case "module-not-found":
      return ["Should the missing module be installed from a package (name and version?) or is it an alias or file path that exists on your side?"];
    case "typescript":
    case "build":
    case "test":
      return [
        `What is the expected behaviour behind the failing check (\`${command}\`)? Paste the requirement, or tell me if the test itself should change.`,
      ];
    case "port-in-use":
      return ["Which port may the app use, or may the process holding the port be stopped?"];
    case "permission":
      return ["Which folder may the agent write to, and may a global install or elevated permission be used (it will not use sudo on its own)?"];
    case "network":
      return ["Is the network or the service the command needs reachable from this machine (VPN, proxy, firewall, a service that is not running)?"];
    case "command-not-found":
      return ["Which tool is missing, and may it be installed on this machine (name and version)?"];
    default:
      return ["What is the missing information or setup change that would make this command succeed?"];
  }
}

const FENCE = "```";

function tail(text: string, max: number): string {
  return text.length <= max ? text : "[...earlier output cut...]\n" + text.slice(-max);
}

/** The exact report format required when the debug attempts are used up. */
export function buildTriageReport(i: TriageInput): string {
  const last = i.attempts[i.attempts.length - 1];
  const history = i.attempts.map((a) => {
    const files = a.filesChanged.length ? ` Files changed: ${a.filesChanged.join(", ")}.` : "";
    const how = a.outcome === "no-patch" ? "no safe patch found" : a.outcome === "still-fails" ? "patched, the command still failed" : "patched, not re-run";
    return `  - Attempt ${a.n}: ${how}. ${a.summary}${files}`;
  });
  const questions = interventions(i.failure, i.command).slice(0, 2);

  return [
    "🚨 Project Failure & Triage Report",
    "",
    "1. System Telemetry & Architecture",
    `- Tech Stack Designed: ${i.project.stack}`,
    `- Target Directories Checked: ${i.project.dirs.join(", ")}`,
    `- Total Automation Attempts: ${i.attempts.length} / ${i.limit}`,
    "",
    "2. Execution Log & Blockers",
    `- Failing Command: ${i.command}`,
    "- Exact Error Output:",
    FENCE,
    tail(i.output.trim(), 3000),
    FENCE,
    "",
    "3. Root Cause Analysis",
    `- Failure type: ${i.failure.kind}. ${i.failure.hint}`,
    `- After ${i.attempts.length} attempt(s) the same command still fails. ${last ? `The last attempt: ${last.summary}` : ""}`.trim(),
    "- Attempt history:",
    ...history,
    "- Why it was not fixed: the fix needs information or a change the agent could not establish from the project and its tools (see the questions below). Repeating the same approach would not change the result, so the run stopped instead of making a further attempt.",
    "",
    "4. Required User Intervention",
    ...questions.map((q, n) => `${n + 1}. ${q}`),
  ].join("\n");
}
