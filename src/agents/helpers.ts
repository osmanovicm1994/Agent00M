// src/agents/helpers.ts
import * as fs from "fs";
import * as path from "path";
import pc from "picocolors";

// Resolved relative to this file so it works from src/ (ts-node) and dist/ (tsc)
// and no matter which directory the CLI is launched from.
const KNOWLEDGE_ROOT = path.resolve(__dirname, "../../src/knowledge");

const DEFAULT_MAX_CHARS = Number(process.env.AGENT_SKILL_CHARS) || 9000;
const warnedMissing = new Set<string>();

function stripFrontMatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}

/**
 * Loads knowledge files (paths relative to src/knowledge, e.g.
 * "07-api/01-endpoint-design.md") and joins them into one prompt section,
 * capped at `maxChars` so a local model's context isn't wasted.
 *
 * Knowledge must be INJECTED into the system prompt: the agent's file tools
 * are scoped to the target project, so it can never open these files itself.
 * A missing file is reported once instead of failing silently.
 */
export function loadKnowledge(relPaths: string[], maxChars: number = DEFAULT_MAX_CHARS): string {
  let out = "";

  for (const rel of relPaths) {
    const full = path.join(KNOWLEDGE_ROOT, rel);
    let text: string;
    try {
      text = stripFrontMatter(fs.readFileSync(full, "utf8"));
    } catch {
      if (!warnedMissing.has(rel)) {
        warnedMissing.add(rel);
        console.warn(pc.yellow(`⚠ Knowledge file not found: src/knowledge/${rel}`));
      }
      continue;
    }
    if (!text) continue;

    const block = `\n\n### STANDARD: ${rel}\n${text}`;
    const remaining = maxChars - out.length;
    if (block.length <= remaining) {
      out += block;
    } else {
      if (remaining > 400) out += block.slice(0, remaining) + "\n[...truncated to fit the prompt budget]";
      break;
    }
  }

  return out ? `\n\n## ENGINEERING STANDARDS (follow these strictly)${out}` : "";
}

/** Legacy single-file helper, kept for backward compatibility. */
export function loadSkill(skillFolder: string, fileName: string = "README.md"): string {
  return loadKnowledge([`${skillFolder}/${fileName}`]);
}

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "bin", "obj", "Pods", "DerivedData", "venv", "__pycache__"]);

const STACK_PRIORITY = [
  "05-backend/csharp-dotnet.md",
  "05-backend/python-fastapi.md",
  "04-frontend/react-nextjs.md",
  "03-mobile/ios-swiftui.md",
  "03-mobile/android-compose.md",
  "02-qa-automation/appium-csharp.md",
  "02-qa-automation/appium-standards.md",
  "02-qa-automation/playwright-standards.md",
];

// Mobile knowledge is split into an entry file per platform plus focused detail files. Only the details that
// fit the agent's role are injected, so a small local model is not flooded with every document.
// Detail files that do not exist yet are skipped silently (add them and they start loading).
const MOBILE_PLATFORMS: Record<string, { entry: string; details: Record<string, string> }> = {
  ios: {
    entry: "03-mobile/ios-swiftui.md",
    details: {
      architecture: "03-mobile/ios-architecture.md",
      ui: "03-mobile/ios-swiftui-ui.md",
      data: "03-mobile/ios-data-networking.md",
      testing: "03-mobile/ios-testing.md",
      build: "03-mobile/ios-build-debug.md",
    },
  },
  android: {
    entry: "03-mobile/android-compose.md",
    details: {
      architecture: "03-mobile/android-architecture.md",
      ui: "03-mobile/android-compose-ui.md",
      data: "03-mobile/android-data-networking.md",
      testing: "03-mobile/android-testing.md",
      build: "03-mobile/android-build-debug.md",
    },
  },
};

// Which detail slots and shared files each agent role gets.
const MOBILE_ROLE: Record<string, { shared: string[]; slots: string[] }> = {
  dev: { shared: ["mobile-common", "mobile-project-analysis"], slots: ["architecture", "ui", "data"] },
  design: { shared: ["mobile-common"], slots: ["ui"] },
  api: { shared: ["mobile-common"], slots: ["data"] },
  qa: { shared: ["mobile-common", "mobile-code-review"], slots: ["testing"] },
  debug: { shared: ["mobile-common", "mobile-project-analysis"], slots: ["build", "architecture", "testing"] },
  logic: { shared: ["mobile-project-analysis"], slots: [] },
  safety: { shared: ["mobile-common", "mobile-code-review"], slots: [] },
};

function knowledgeExists(rel: string): boolean {
  return fs.existsSync(path.join(KNOWLEDGE_ROOT, rel));
}

function addMobileDetails(base: string[], agentId: string): string[] {
  const role = MOBILE_ROLE[agentId];
  if (!role) return base;
  const platforms = Object.values(MOBILE_PLATFORMS).filter((p) => base.includes(p.entry));
  if (!platforms.length) return base;

  const extra: string[] = [];
  for (const s of role.shared) extra.push(`03-mobile/${s}.md`);
  for (const p of platforms) for (const slot of role.slots) if (p.details[slot]) extra.push(p.details[slot]);
  // Placed right after the mobile entry files (before Appium/other stacks): entry first, then shared rules,
  // then role details, so the prompt budget cuts the least important text first.
  const at = Math.max(...platforms.map((p) => base.indexOf(p.entry))) + 1;
  const add = extra.filter((f) => !base.includes(f) && knowledgeExists(f));
  return [...base.slice(0, at), ...add, ...base.slice(at)];
}

function inspectDir(dir: string, found: Set<string>): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }

  const readSmall = (name: string): string => {
    try {
      return fs.readFileSync(path.join(dir, name), "utf8").slice(0, 20_000);
    } catch {
      return "";
    }
  };

  for (const name of names) {
    const lower = name.toLowerCase();

    if (lower === "package.json") {
      try {
        const pkg = JSON.parse(readSmall(name));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.react || deps.next) found.add("04-frontend/react-nextjs.md");
        if (deps["@playwright/test"] || deps.playwright) found.add("02-qa-automation/playwright-standards.md");
      } catch {
        // malformed package.json — ignore
      }
    } else if (lower.endsWith(".csproj")) {
      found.add("05-backend/csharp-dotnet.md");
      if (/appium/i.test(readSmall(name))) {
        found.add("02-qa-automation/appium-csharp.md");
        found.add("02-qa-automation/appium-standards.md");
      }
    } else if (lower.endsWith(".sln")) {
      found.add("05-backend/csharp-dotnet.md");
    } else if (lower === "requirements.txt" || lower === "pyproject.toml") {
      if (/fastapi/i.test(readSmall(name))) found.add("05-backend/python-fastapi.md");
    } else if (lower === "package.swift" || lower.endsWith(".xcodeproj") || lower.endsWith(".xcworkspace")) {
      found.add("03-mobile/ios-swiftui.md");
    } else if (lower === "build.gradle" || lower === "build.gradle.kts") {
      found.add("03-mobile/android-compose.md");
    }
  }
}

/**
 * Detects the target project's stack from marker files (root, its immediate
 * subfolders, and apps/* + packages/* for monorepos) and returns the knowledge
 * files that apply, so e.g. a C# project automatically gets the C# standards.
 */
export function detectStackKnowledge(workspaceRoot: string, agentId?: string): string[] {
  const found = new Set<string>();
  const dirs: string[] = [workspaceRoot];

  const addChildren = (base: string) => {
    try {
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) {
          dirs.push(path.join(base, entry.name));
        }
      }
    } catch {
      // unreadable — skip
    }
  };

  addChildren(workspaceRoot);
  for (const container of ["apps", "packages", "src"]) addChildren(path.join(workspaceRoot, container));

  for (const dir of dirs.slice(0, 60)) inspectDir(dir, found);

  const base = STACK_PRIORITY.filter((p) => found.has(p));
  return agentId ? addMobileDetails(base, agentId) : base;
}
