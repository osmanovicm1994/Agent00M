// src/core/toolchain-doctor.ts
//
// The agent's "environment doctor": deterministic checks (no model, no network) for the failures that stop a
// non-developer cold, because the fix is outside the code and a local model guesses wrong:
//
//   1. install loop      package.json has a lifecycle script such as  "install": "npm install"  that starts the very
//                        command that runs it. `npm install` then calls itself forever (seen in a real run: 6+ minutes,
//                        the same "> europ@1.0.0 install / > npm install" banner over and over).
//   2. engine mismatch   "EBADENGINE Unsupported engine": a package (or npm itself) needs a newer Node.js than the
//                        computer has. npm cannot fix that; Node has to be upgraded, and how depends on how Node was
//                        installed (Homebrew, nvm, fnm, Volta, asdf, the installer).
//   3. npm self-upgrade  `npm install -g npm@latest` as a "fix". Upgrading npm is almost never the cure: npm 12 needs a
//                        recent Node and turns dependency install scripts off by default, so it can break native
//                        packages even where it installs. The npm that ships with Node is enough.
//
// Used in three places (see executor.ts, shell.tool.ts):
//   - adviseBeforeRun()  refuses a command that is known to loop or fail, BEFORE it runs, and says what to do instead,
//   - LoopWatch          watches a running command's output and stops it when it repeats a lifecycle banner,
//   - diagnoseFailure()  after a failed command, turns the raw output into verified facts + exact steps.
//
// Everything here is pure (strings in, strings out) so it is unit-tested without touching the system.

import * as path from "path";

export type DiagnosisKind = "install-loop" | "engine-mismatch" | "engine-warning" | "global-npm-upgrade";

export interface Diagnosis {
  kind: DiagnosisKind;
  /** One plain sentence a non-developer understands. */
  summary: string;
  /** Facts taken from the output or files, never guessed. */
  facts: string[];
  /** Ordered concrete steps: commands to run or files to edit. */
  steps: string[];
  /** Things the agent must not do (the usual wrong moves for this problem). */
  doNot: string[];
  /** True when only the user can fix it (a change outside the project): the run should stop and say so. */
  userMustAct: boolean;
}

// ---------------------------------------------------------------------------
// Version ranges (the small subset of semver that "engines" fields use)
// ---------------------------------------------------------------------------

type Triple = [number, number, number];

function parseVersion(v: string): Triple | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function compare(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

interface Comparator {
  op: ">=" | ">" | "<=" | "<" | "=";
  v: Triple;
}

/** One range token such as ^24.15.0, ~22.1, >=26, 20.x, 18.1.0 as 1-2 comparators. Null when it cannot be read. */
function comparatorsOf(token: string): Comparator[] | null {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?$/.exec(token);
  if (!m) return null;
  const op = m[1] ?? "";
  const wild = (s: string | undefined) => s === undefined || /^[xX*]$/.test(s);
  if (wild(m[2])) return []; // "*" / "x": anything
  const major = Number(m[2]);
  const minor = wild(m[3]) ? undefined : Number(m[3]);
  const patch = wild(m[4]) ? undefined : Number(m[4]);
  const low: Triple = [major, minor ?? 0, patch ?? 0];

  if (op === "^") {
    const high: Triple = major > 0 ? [major + 1, 0, 0] : minor !== undefined && minor > 0 ? [0, minor + 1, 0] : [0, 0, (patch ?? 0) + 1];
    return [{ op: ">=", v: low }, { op: "<", v: high }];
  }
  if (op === "~") {
    const high: Triple = minor === undefined ? [major + 1, 0, 0] : [major, minor + 1, 0];
    return [{ op: ">=", v: low }, { op: "<", v: high }];
  }
  if (op === ">=" || op === ">" || op === "<=" || op === "<") return [{ op: op as Comparator["op"], v: low }];
  // Plain version: exact when complete, a window when partial ("20", "20.x", "20.1").
  if (patch !== undefined) return [{ op: "=", v: low }];
  const high: Triple = minor === undefined ? [major + 1, 0, 0] : [major, minor + 1, 0];
  return [{ op: ">=", v: low }, { op: "<", v: high }];
}

function holds(version: Triple, c: Comparator): boolean {
  const d = compare(version, c.v);
  switch (c.op) {
    case ">=": return d >= 0;
    case ">": return d > 0;
    case "<=": return d <= 0;
    case "<": return d < 0;
    default: return d === 0;
  }
}

/** True when `version` satisfies the Node `engines` range. Unreadable ranges count as satisfied (never a false alarm). */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return true;
  const clauses = range.split("||").map((c) => c.trim()).filter(Boolean);
  if (clauses.length === 0) return true;
  for (const clause of clauses) {
    // "">= 1.2.3" with a space after the operator is one token.
    const tokens = clause.replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split(/\s+/).filter(Boolean);
    let ok = true;
    for (const t of tokens) {
      const cs = comparatorsOf(t);
      if (cs === null) return true; // something exotic: do not guess
      if (!cs.every((c) => holds(v, c))) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/** The Node major to install: the current line when the range allows it (24.3 -> 24), else the next higher one, else the highest. */
export function pickTargetNodeMajor(range: string, currentNode?: string): number | null {
  const majors: number[] = [];
  for (const clause of range.split("||")) {
    const first = clause.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split(/\s+/)[0] ?? "";
    const m = /^(?:\^|~|>=|>|=)?v?(\d+)/.exec(first);
    if (m) majors.push(Number(m[1]));
  }
  if (majors.length === 0) return null;
  const current = currentNode ? parseVersion(currentNode)?.[0] : undefined;
  if (current !== undefined) {
    if (majors.includes(current)) return current;
    const higher = majors.filter((n) => n > current).sort((a, b) => a - b)[0];
    if (higher !== undefined) return higher;
  }
  return Math.max(...majors);
}

// ---------------------------------------------------------------------------
// How Node was installed
// ---------------------------------------------------------------------------

export type NodeManager = "homebrew" | "nvm" | "fnm" | "volta" | "asdf" | "n" | "windows" | "system" | "unknown";

export function detectNodeManager(nodePath: string | undefined): NodeManager {
  const p = (nodePath ?? "").replace(/\\/g, "/");
  if (!p) return "unknown";
  if (/\/\.nvm\//.test(p)) return "nvm";
  if (/\/\.?fnm|fnm_multishells/.test(p)) return "fnm";
  if (/\/\.volta\//.test(p)) return "volta";
  if (/\/\.asdf\//.test(p)) return "asdf";
  if (/\/Cellar\/node|\/opt\/homebrew\/|\/linuxbrew\/|\/homebrew\//.test(p)) return "homebrew";
  if (/\/n\/versions\/node\/|\/usr\/local\/n\//.test(p)) return "n";
  if (/^[a-z]:\/|\/program files\/nodejs|\/nodejs\/node\.exe/i.test(p)) return "windows";
  if (/^\/usr\/(local\/)?bin\/node$/.test(p)) return "system";
  return "unknown";
}

const MANAGER_LABEL: Record<NodeManager, string> = {
  homebrew: "Homebrew",
  nvm: "nvm",
  fnm: "fnm",
  volta: "Volta",
  asdf: "asdf",
  n: "n",
  windows: "the Windows installer",
  system: "the system package manager",
  unknown: "an unknown method",
};

// Addressed to the person (second person): when only they can fix it, this text is the final message of the run.
function upgradeSteps(manager: NodeManager, major: number, range: string): string[] {
  const restart = "Close the terminal, open a new one and run `node -v`: it must show the new version. Then start the agent again and repeat your request.";
  switch (manager) {
    case "homebrew":
      return [
        "Run `brew update && brew upgrade node` in your terminal (this changes Node.js for every project on this computer).",
        `Check \`node -v\`. It must satisfy ${range}. If Homebrew's newest Node is outside that range, install the matching line instead: \`brew install node@${major} && brew link --overwrite --force node@${major}\`.`,
        restart,
      ];
    case "nvm":
      return [`Run in your own terminal (nvm only exists inside your terminal, the agent cannot run it): \`nvm install ${major} && nvm alias default ${major}\``, restart];
    case "fnm":
      return [`Run in your own terminal: \`fnm install ${major} && fnm default ${major}\``, restart];
    case "volta":
      return [`Run in your terminal: \`volta install node@${major}\``, restart];
    case "asdf":
      return [`Run in your own terminal: \`asdf install nodejs latest:${major} && asdf global nodejs latest:${major}\``, restart];
    case "n":
      return [`Run in your terminal: \`n ${major}\` (it may ask for your password).`, restart];
    default:
      return [`Install Node.js ${major}.x (the LTS download) from https://nodejs.org, using the installer for your operating system.`, restart];
  }
}

// ---------------------------------------------------------------------------
// Engine mismatch (EBADENGINE)
// ---------------------------------------------------------------------------

export interface EngineMismatch {
  /** The package that is too new for this Node, e.g. "npm@12.2.1" or "vite@8.0.0". */
  pkg?: string;
  requiredNode?: string;
  actualNode?: string;
  actualNpm?: string;
  /** true: the install FAILED because of it (error). false: only a warning. */
  strict: boolean;
}

/** `{ node: '>=22' }` or `{"node":">=22"}` -> object. Null when unreadable. */
function looseObject(text: string): Record<string, string> | null {
  const cleaned = text.replace(/'/g, '"').replace(/([{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":');
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : null;
  } catch {
    return null;
  }
}

export function parseEngineMismatch(output: string): EngineMismatch | null {
  // npm prefixes every line ("npm error notsup ..."); drop that so the shapes below are the same for warn and error.
  const text = output.replace(/^npm (?:warn|error|ERR!|WARN)\s+(?:EBADENGINE|notsup|engine)\s?/gim, "");
  const strict =
    /npm (?:error|ERR!)\s+code EBADENGINE/i.test(output) ||
    /ERR_PNPM_UNSUPPORTED_ENGINE/.test(output) ||
    /error [^\n]*The engine "node" is incompatible with this module/.test(output);

  // npm 7+ error form
  const pkgError = /Not compatible with your version of node\/npm:\s*(\S+)/.exec(text);
  const requiredError = /Required:\s*(\{[^\n]*\})/.exec(text);
  const actualError = /Actual:\s*(\{[^\n]*\})/.exec(text);
  if (pkgError || requiredError) {
    const req = requiredError ? looseObject(requiredError[1]) : null;
    const act = actualError ? looseObject(actualError[1]) : null;
    return { pkg: pkgError?.[1], requiredNode: req?.node, actualNode: act?.node, actualNpm: act?.npm, strict };
  }

  // npm warn form: package: 'x@1',  required: { node: '>=22' },  current: { node: 'v20', npm: '10' }
  if (/EBADENGINE/.test(output)) {
    const pkg = /package:\s*'([^']+)'/.exec(text)?.[1];
    const required = /required:\s*(\{[^}]*\})/.exec(text);
    const current = /current:\s*(\{[^}]*\})/.exec(text);
    const req = required ? looseObject(required[1]) : null;
    const cur = current ? looseObject(current[1]) : null;
    return { pkg, requiredNode: req?.node, actualNode: cur?.node, actualNpm: cur?.npm, strict };
  }

  // yarn: error vite@8.0.0: The engine "node" is incompatible with this module. Expected version ">=22". Got "20.1.0"
  const yarn = /error ([^\s:]+): The engine "node" is incompatible with this module\. Expected version "([^"]+)"\. Got "([^"]+)"/.exec(output);
  if (yarn) return { pkg: yarn[1], requiredNode: yarn[2], actualNode: yarn[3], strict: true };

  // pnpm: Unsupported engine: wanted: {"node":">=22"} (current: {"node":"v20.1.0","pnpm":"9.0.0"})
  const pnpm = /Unsupported engine:[^\n]*?wanted:\s*(\{[^}]*\})[^\n]*?current:\s*(\{[^}]*\})/.exec(output);
  if (pnpm) {
    const req = looseObject(pnpm[1]);
    const cur = looseObject(pnpm[2]);
    return { requiredNode: req?.node, actualNode: cur?.node, strict };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Install loop
// ---------------------------------------------------------------------------

const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepare", "prepublish", "preprepare", "postprepare"] as const;
const MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const INSTALL_VERBS = new Set(["install", "i", "ci"]);
const VALUE_FLAGS = new Set(["--loglevel", "--registry", "--cache", "--userconfig", "--tag", "--omit", "--include", "--otp"]);
const DIR_VALUE_FLAG = /^(--prefix|--cwd|--dir|-C)$/;
const DIR_VALUE_FLAG_EQ = /^(--prefix|--cwd|--dir|-C)=(.+)$/;
const OTHER_TARGET_FLAG = /^(--workspace|-w|--workspaces|--filter|-F|--global|-g|--location)(=|$)/;

function tokensOf(segment: string): string[] {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  return tokens;
}

/** Where a package-manager install in this token list installs: its folder (relative), or null when it is not a plain install. */
function installDir(tokens: string[]): { dir?: string } | null {
  if (!MANAGERS.has(tokens[0] ?? "")) return null;
  const manager = tokens[0];
  let dir: string | undefined;
  let verb: string | undefined;
  let packageArgs = false;
  let otherTarget = false;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("-")) {
      const eq = DIR_VALUE_FLAG_EQ.exec(t);
      if (eq) {
        dir = eq[2];
      } else if (DIR_VALUE_FLAG.test(t)) {
        dir = tokens[i + 1];
        i++;
      } else if (OTHER_TARGET_FLAG.test(t)) {
        otherTarget = true;
      } else if (VALUE_FLAGS.has(t)) {
        i++;
      }
      continue;
    }
    if (verb === undefined) verb = t;
    else packageArgs = true;
  }
  if (verb === undefined) {
    if (manager !== "yarn") return null; // a bare `yarn` is an install
    verb = "install";
  }
  if (!INSTALL_VERBS.has(verb) || packageArgs || otherTarget) return null;
  return { dir };
}

function joinDir(cwd: string, next: string): string {
  const cleaned = next.replace(/^["']|["']$/g, "");
  if (/^[/~]|\$/.test(cleaned)) return cleaned; // absolute or variable: cannot be resolved here
  return path.posix.normalize(path.posix.join(cwd, cleaned)) || ".";
}

/** Folders (relative to where the command starts) that this command runs a plain install in. */
export function installTargets(command: string): string[] {
  const targets: string[] = [];
  let cwd = ".";
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const tokens = tokensOf(segment);
    if (tokens.length === 0) continue;
    if (tokens[0] === "cd" && tokens[1]) {
      cwd = joinDir(cwd, tokens[1]);
      continue;
    }
    const target = installDir(tokens);
    if (target) targets.push(joinDir(cwd, target.dir ?? "."));
  }
  return [...new Set(targets)];
}

export interface RecursiveScript {
  script: string;
  command: string;
}

/** Runs of `npm run <name>` inside a script, to see through one script calling another. */
function runTargets(command: string): string[] {
  const names: string[] = [];
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const t = tokensOf(segment);
    if (MANAGERS.has(t[0] ?? "") && (t[1] === "run" || t[1] === "run-script") && t[2] && !t[2].startsWith("-")) names.push(t[2]);
  }
  return names;
}

/** Lifecycle scripts of a package.json that start a plain install in their own folder (directly or via `npm run x`). */
export function findRecursiveInstallScripts(packageJsonText: string): RecursiveScript[] {
  let scripts: Record<string, unknown>;
  try {
    const parsed = JSON.parse(packageJsonText);
    if (!parsed || typeof parsed.scripts !== "object" || parsed.scripts === null) return [];
    scripts = parsed.scripts;
  } catch {
    return [];
  }
  const recursive = (command: string, depth: number): boolean => {
    if (installTargets(command).includes(".")) return true;
    if (depth >= 4) return false;
    return runTargets(command).some((name) => typeof scripts[name] === "string" && recursive(scripts[name] as string, depth + 1));
  };
  const found: RecursiveScript[] = [];
  for (const hook of INSTALL_HOOKS) {
    const command = scripts[hook];
    if (typeof command === "string" && recursive(command, 0)) found.push({ script: hook, command });
  }
  return found;
}

export interface LoopFinding {
  pkg: string;
  script: string;
  command: string;
  count: number;
}

const BANNER = new RegExp(`^>\\s+(\\S+@\\S+)\\s+(${INSTALL_HOOKS.join("|")})(?:\\s+.*)?$`);
const BANNER_COMMAND = /^>\s+(.+?)\s*$/;

/**
 * Watches the output of a running command, chunk by chunk, for the signature of an install loop: the same npm
 * lifecycle banner ("> pkg@1.0.0 install" followed by "> npm install") printed again and again.
 */
export class LoopWatch {
  private carry = "";
  private pending: { pkg: string; script: string } | undefined;
  private readonly counts = new Map<string, number>();

  constructor(private readonly limit = 3) {}

  /** Returns a finding once the same banner has been seen `limit` times, else null. */
  feed(chunk: string): LoopFinding | null {
    const text = this.carry + chunk.replace(/\r/g, "");
    const lines = text.split("\n");
    this.carry = lines.pop() ?? "";
    for (const line of lines) {
      const banner = BANNER.exec(line);
      if (banner) {
        this.pending = { pkg: banner[1], script: banner[2] };
        continue;
      }
      if (!this.pending) continue;
      const cmd = BANNER_COMMAND.exec(line);
      if (!cmd) {
        if (line.trim() !== "") this.pending = undefined;
        continue;
      }
      const { pkg, script } = this.pending;
      this.pending = undefined;
      const key = `${pkg}|${script}|${cmd[1]}`;
      const count = (this.counts.get(key) ?? 0) + 1;
      this.counts.set(key, count);
      if (count >= this.limit) return { pkg, script, command: cmd[1], count };
    }
    return null;
  }
}

/** The same check over a finished output. */
export function findLoopInOutput(output: string, limit = 3): LoopFinding | null {
  const watch = new LoopWatch(limit);
  return watch.feed(output + "\n");
}

function loopDiagnosis(script: RecursiveScript, where: string, observed?: LoopFinding): Diagnosis {
  const file = where === "." ? "package.json" : `${where}/package.json`;
  return {
    kind: "install-loop",
    summary: `\`npm install\` would run itself forever: ${file} has a "${script.script}" script that runs \`${script.command}\`, and npm runs that script at the end of every install.`,
    facts: [
      `${file} → scripts.${script.script} = "${script.command}"`,
      "npm runs the install-time scripts (preinstall, install, postinstall, prepare) of the project itself after `npm install`. A script that starts another install therefore restarts the whole thing.",
      ...(observed ? [`Seen in the output: the banner "> ${observed.pkg} ${observed.script}" followed by "> ${observed.command}" ${observed.count} times in a row.`] : []),
    ],
    steps: [
      `Open ${file} and delete the "${script.script}" line from "scripts". Nothing has to replace it: \`npm install\` already installs the project's dependencies.`,
      `If the line was meant to install a sub-folder, give it a name that npm does not run automatically and point it at that folder, for example "setup": "npm --prefix web install" (or use npm workspaces).`,
      "Then run `npm install` once and check that it ends by itself.",
    ],
    doNot: [
      `Do not run \`npm install\` again before ${file} is fixed: it will loop again.`,
      "Do not delete node_modules, the lockfile or the npm cache: they are not the cause.",
      "Do not upgrade npm or Node.js: the version is not the cause.",
    ],
    userMustAct: false,
  };
}

// ---------------------------------------------------------------------------
// npm self-upgrade
// ---------------------------------------------------------------------------

/** `npm install -g npm@latest`, `npm i -g npm`, `npm update -g npm`, `pnpm add -g npm@next` ... */
export function isGlobalNpmUpgrade(command: string): boolean {
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const t = tokensOf(segment);
    if (!MANAGERS.has(t[0] ?? "")) continue;
    const rest = t.slice(1);
    const global = rest.some((x) => x === "-g" || x === "--global");
    const verbAt = rest.findIndex((x) => !x.startsWith("-"));
    if (!global || verbAt < 0 || !/^(install|i|add|update|up|upgrade)$/.test(rest[verbAt])) continue;
    // Only the packages named after the verb count (the command's own "npm" is not a package).
    if (rest.slice(verbAt + 1).some((x) => /^npm(@(latest|next|\*))?$/.test(x))) return true;
  }
  return false;
}

function globalNpmDiagnosis(mismatch?: EngineMismatch): Diagnosis {
  const facts = [
    "The npm that came with Node.js already installs and runs projects; an old npm is almost never the cause of a failure.",
    "npm@latest (npm 12 and newer) needs a recent Node.js and, by default, no longer runs the install scripts of dependencies, which breaks packages that build native code (sharp, better-sqlite3, ...).",
  ];
  if (mismatch?.requiredNode) {
    facts.unshift(
      `The attempt failed: ${mismatch.pkg ?? "this npm"} needs Node.js ${mismatch.requiredNode}, this computer has ${mismatch.actualNode ?? "an older one"}${mismatch.actualNpm ? ` (npm ${mismatch.actualNpm})` : ""}.`,
    );
  }
  return {
    kind: "global-npm-upgrade",
    summary: "Upgrading npm is not the fix here, and `npm install -g npm@latest` cannot work on this Node.js version.",
    facts,
    steps: [
      "Skip the npm upgrade. Go back to the original failing command and read its FIRST error line: that is the real problem.",
      "Only if the user explicitly asks for a newer npm: pin a major that the installed Node.js supports, for example `npm install -g npm@11` (needs the user's approval).",
    ],
    doNot: [
      "Do not run `npm install -g npm@latest` or any variant of it again.",
      "Do not blame the npm version for a failure whose output does not name it.",
    ],
    userMustAct: false,
  };
}

function engineDiagnosis(m: EngineMismatch, nodePath: string | undefined, nodeVersion: string | undefined): Diagnosis {
  const actualNode = m.actualNode ?? nodeVersion;
  const required = m.requiredNode;
  if (!m.strict) {
    return {
      kind: "engine-warning",
      summary: `EBADENGINE is only a warning here (${m.pkg ?? "a package"} prefers Node.js ${required ?? "a newer version"}); it is not what made the command fail.`,
      facts: [`Required by ${m.pkg ?? "the package"}: Node.js ${required ?? "?"}; this computer has ${actualNode ?? "?"}.`],
      steps: ["Look in the output for the first line that starts with `npm error` and is NOT about EBADENGINE: that is the real failure. Fix that one."],
      doNot: ["Do not upgrade Node.js or npm because of a warning.", "Do not set engine-strict or edit `engines` to hide it."],
      userMustAct: false,
    };
  }
  if (m.pkg && /^npm@/.test(m.pkg)) return globalNpmDiagnosis(m);

  const manager = detectNodeManager(nodePath);
  const range = required ?? "a newer version";
  const major = required ? pickTargetNodeMajor(required, actualNode) : null;
  const steps = major !== null ? upgradeSteps(manager, major, range) : ["Upgrade Node.js to the newest LTS release from https://nodejs.org and restart the terminal."];
  const name = m.pkg ? m.pkg.replace(/@[^@]*$/, "") : undefined;
  if (name && name !== m.pkg) {
    steps.push(
      `Alternative that keeps your Node.js: use an older ${name} whose "engines" allow ${actualNode ?? "your Node.js"} (\`npm view ${name} versions --json\`, then \`npm view ${name}@<version> engines\`) and ask the agent to pin that version.`,
    );
  }
  return {
    kind: "engine-mismatch",
    summary: `${m.pkg ?? "A package"} needs Node.js ${range}, but this computer has Node.js ${actualNode ?? "an older version"}. Only upgrading Node.js (or choosing an older version of that package) fixes this.`,
    facts: [
      `Needs: Node.js ${range}`,
      `This computer: Node.js ${actualNode ?? "?"}${m.actualNpm ? `, npm ${m.actualNpm}` : ""}`,
      `Node.js was installed with: ${MANAGER_LABEL[manager]}${nodePath ? ` (${nodePath})` : ""}`,
      "npm cannot change the Node.js version, so upgrading npm does not help.",
    ],
    steps,
    doNot: [
      "Do not upgrade npm to fix a Node.js version problem.",
      "Do not delete node_modules or the lockfile: they are not the cause.",
      "Do not edit `engines` or set engine-strict=false just to make the message go away, unless the user asks for that.",
    ],
    userMustAct: true,
  };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export interface DiagnoseInput {
  command: string;
  output: string;
  /** Path of the node binary in use (process.execPath). */
  nodePath?: string;
  /** process.version */
  nodeVersion?: string;
  /** Reads the package.json of a folder (relative to the workspace); undefined when there is none. */
  readPackageJson?: (dir: string) => string | undefined;
}

/** After a failed command: facts + exact steps for the problems this module knows, else null. */
export function diagnoseFailure(input: DiagnoseInput): Diagnosis | null {
  const loop = findLoopInOutput(input.output);
  if (loop) {
    const dir = installTargets(input.command)[0] ?? ".";
    const text = input.readPackageJson?.(dir);
    const found = text ? findRecursiveInstallScripts(text).find((s) => s.script === loop.script) : undefined;
    return loopDiagnosis(found ?? { script: loop.script, command: loop.command }, dir, loop);
  }

  const mismatch = parseEngineMismatch(input.output);
  if (mismatch) {
    // The agent's own node is the one the user's shell uses unless the output names another one.
    const fromOutput = /(\/\S*\/node)\s+\S*\/npm(?:-cli\.js)?\b/.exec(input.output)?.[1];
    const d = engineDiagnosis(mismatch, fromOutput ?? input.nodePath, input.nodeVersion);
    return isGlobalNpmUpgrade(input.command) && d.kind === "engine-mismatch" ? globalNpmDiagnosis(mismatch) : d;
  }
  return null;
}

export interface Advice {
  /** The tool result to give the model instead of running the command. */
  refuse: string;
  diagnosis: Diagnosis;
}

/** Before a command runs: refuse the ones that are known to loop or to fail for a reason outside the code. */
export function adviseBeforeRun(command: string, readPackageJson: (dir: string) => string | undefined): Advice | null {
  if (isGlobalNpmUpgrade(command)) {
    const diagnosis = globalNpmDiagnosis();
    return { diagnosis, refuse: `This command was NOT run. ${formatDiagnosis(diagnosis)}` };
  }
  for (const dir of installTargets(command)) {
    const text = readPackageJson(dir);
    if (!text) continue;
    const bad = findRecursiveInstallScripts(text)[0];
    if (bad) {
      const diagnosis = loopDiagnosis(bad, dir);
      return { diagnosis, refuse: `This command was NOT run. ${formatDiagnosis(diagnosis)}` };
    }
  }
  return null;
}

/** For a write: package.json content that would introduce an install loop (so the agent never creates one). */
export function refuseRecursiveInstallScript(content: string): string | null {
  const bad = findRecursiveInstallScripts(content)[0];
  if (!bad) return null;
  return (
    `TOOL ERROR: refused to write package.json: scripts.${bad.script} is "${bad.command}". npm runs that script after every \`npm install\`, so the install would start itself forever. ` +
    `Remove it; \`npm install\` already installs the dependencies. To install a sub-folder, use a name npm does not run on its own, e.g. "setup": "npm --prefix <dir> install".`
  );
}

/** The text for the model: verified facts first, then what to do and what not to do. */
export function formatDiagnosis(d: Diagnosis): string {
  return [
    `TOOLCHAIN DIAGNOSIS (checked by the agent, not a guess): ${d.summary}`,
    "Facts:",
    ...d.facts.map((f) => `- ${f}`),
    "Do this:",
    ...d.steps.map((s, i) => `${i + 1}. ${s}`),
    "Do NOT:",
    ...d.doNot.map((s) => `- ${s}`),
  ].join("\n");
}

/** The final message for the person when only they can fix it: plain words, commands ready to copy. */
export function haltText(d: Diagnosis): string {
  return [
    d.userMustAct
      ? "I stopped here on purpose: this cannot be fixed from inside the project."
      : "I stopped here because the same blocked step kept coming back. This is what I found out:",
    "",
    `What is wrong: ${d.summary}`,
    "",
    ...d.facts.map((f) => `• ${f}`),
    "",
    "What to do:",
    ...d.steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    d.userMustAct
      ? "After that, start the agent again and send the same request; it will continue from the current state of the project."
      : "Tell me to continue and I will start with the first step above.",
  ].join("\n");
}
