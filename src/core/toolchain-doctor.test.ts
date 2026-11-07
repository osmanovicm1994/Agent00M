import { describe, expect, it } from "vitest";
import {
  LoopWatch,
  adviseBeforeRun,
  detectNodeManager,
  diagnoseFailure,
  findLoopInOutput,
  findRecursiveInstallScripts,
  formatDiagnosis,
  haltText,
  installTargets,
  isGlobalNpmUpgrade,
  parseEngineMismatch,
  pickTargetNodeMajor,
  refuseRecursiveInstallScript,
  satisfiesRange,
} from "./toolchain-doctor";

// The real output of the failed run (npm 11.4.2 on Node 24.3.0, Homebrew).
const EBADENGINE_LOG = `npm error code EBADENGINE
npm error engine Unsupported engine
npm error engine Not compatible with your version of node/npm: npm@12.2.1
npm error notsup Not compatible with your version of node/npm: npm@12.2.1
npm error notsup Required: {"node":"^22.22.2 || ^24.15.0 || >=26.0.0"}
npm error notsup Actual:   {"npm":"11.4.2","node":"v24.3.0"}
npm error A complete log of this run can be found in: /Users/me/.npm/_logs/x-debug-0.log`;

const LOOP_BLOCK = `> europ@1.0.0 install
> npm install

npm verbose cli /opt/homebrew/Cellar/node/24.3.0/bin/node /opt/homebrew/bin/npm
npm info using npm@11.4.2
npm http fetch POST 200 https://registry.npmjs.org/-/npm/v1/security/advisories/bulk 387ms
`;

describe("satisfiesRange", () => {
  const range = "^22.22.2 || ^24.15.0 || >=26.0.0";
  it.each([
    ["v24.3.0", false],
    ["24.14.9", false],
    ["v24.15.0", true],
    ["24.99.1", true],
    ["22.22.2", true],
    ["22.22.1", false],
    ["v25.1.0", false],
    ["26.0.0", true],
    ["30.1.0", true],
    ["20.1.0", false],
  ])("%s -> %s", (version, expected) => {
    expect(satisfiesRange(version, range)).toBe(expected);
  });

  it("reads the other common forms", () => {
    expect(satisfiesRange("20.5.0", ">=18")).toBe(true);
    expect(satisfiesRange("16.0.0", ">=18")).toBe(false);
    expect(satisfiesRange("18.2.0", "18.x")).toBe(true);
    expect(satisfiesRange("19.0.0", "18.x")).toBe(false);
    expect(satisfiesRange("20.3.1", "~20.3.0")).toBe(true);
    expect(satisfiesRange("20.4.0", "~20.3.0")).toBe(false);
    expect(satisfiesRange("20.5.0", ">= 18 < 21")).toBe(true);
    expect(satisfiesRange("21.0.0", ">=18 <21")).toBe(false);
    expect(satisfiesRange("20.0.0", "*")).toBe(true);
  });

  it("never raises a false alarm for ranges or versions it cannot read", () => {
    expect(satisfiesRange("20.0.0", "lts/*")).toBe(true);
    expect(satisfiesRange("not-a-version", ">=22")).toBe(true);
    expect(satisfiesRange("20.0.0", "")).toBe(true);
  });
});

describe("pickTargetNodeMajor", () => {
  const range = "^22.22.2 || ^24.15.0 || >=26.0.0";
  it("stays on the current line when the range allows it", () => {
    expect(pickTargetNodeMajor(range, "v24.3.0")).toBe(24);
    expect(pickTargetNodeMajor(range, "22.1.0")).toBe(22);
  });
  it("goes to the next higher line otherwise, and to the highest when already above", () => {
    expect(pickTargetNodeMajor(range, "20.1.0")).toBe(22);
    expect(pickTargetNodeMajor(range, "25.0.0")).toBe(26);
    expect(pickTargetNodeMajor(range, "30.0.0")).toBe(26);
    expect(pickTargetNodeMajor(">=22", "18.0.0")).toBe(22);
    expect(pickTargetNodeMajor("", "18.0.0")).toBeNull();
  });
});

describe("detectNodeManager", () => {
  it.each([
    ["/opt/homebrew/Cellar/node/24.3.0/bin/node", "homebrew"],
    ["/usr/local/Cellar/node/24.3.0/bin/node", "homebrew"],
    ["/opt/homebrew/opt/node@22/bin/node", "homebrew"],
    ["/Users/me/.nvm/versions/node/v22.1.0/bin/node", "nvm"],
    ["/Users/me/.fnm/node-versions/v22.1.0/installation/bin/node", "fnm"],
    ["/Users/me/.volta/tools/image/node/22.1.0/bin/node", "volta"],
    ["/Users/me/.asdf/installs/nodejs/22.1.0/bin/node", "asdf"],
    ["C:\\Program Files\\nodejs\\node.exe", "windows"],
    ["/usr/bin/node", "system"],
    ["/somewhere/odd/node", "unknown"],
    [undefined, "unknown"],
  ])("%s -> %s", (p, expected) => {
    expect(detectNodeManager(p as string | undefined)).toBe(expected);
  });
});

describe("parseEngineMismatch", () => {
  it("reads the npm error form from the real log", () => {
    expect(parseEngineMismatch(EBADENGINE_LOG)).toEqual({
      pkg: "npm@12.2.1",
      requiredNode: "^22.22.2 || ^24.15.0 || >=26.0.0",
      actualNode: "v24.3.0",
      actualNpm: "11.4.2",
      strict: true,
    });
  });

  it("reads the npm warning form and marks it not strict", () => {
    const warn = `npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: 'vite@8.0.0',
npm warn EBADENGINE   required: { node: '>=22' },
npm warn EBADENGINE   current: { node: 'v20.1.0', npm: '10.0.0' }
npm warn EBADENGINE }`;
    expect(parseEngineMismatch(warn)).toEqual({ pkg: "vite@8.0.0", requiredNode: ">=22", actualNode: "v20.1.0", actualNpm: "10.0.0", strict: false });
  });

  it("reads yarn and pnpm", () => {
    const yarn = 'error vite@8.0.0: The engine "node" is incompatible with this module. Expected version ">=22". Got "20.1.0"';
    expect(parseEngineMismatch(yarn)).toMatchObject({ pkg: "vite@8.0.0", requiredNode: ">=22", actualNode: "20.1.0", strict: true });
    const pnpm = ' ERR_PNPM_UNSUPPORTED_ENGINE  Unsupported engine: wanted: {"node":">=22"} (current: {"node":"v20.1.0","pnpm":"9.0.0"})';
    expect(parseEngineMismatch(pnpm)).toMatchObject({ requiredNode: ">=22", actualNode: "v20.1.0", strict: true });
  });

  it("returns null for unrelated output", () => {
    expect(parseEngineMismatch("npm error code E404")).toBeNull();
  });
});

describe("installTargets", () => {
  it.each([
    ["npm install", ["."]],
    ["npm i", ["."]],
    ["npm ci --omit dev", ["."]],
    ["npm install --no-audit --no-fund", ["."]],
    ["yarn", ["."]],
    ["pnpm install", ["."]],
    ["bun install", ["."]],
    ["CI=1 npm install", ["."]],
    ["npm --prefix web install", ["web"]],
    ["npm install --prefix=web", ["web"]],
    ["cd web && npm install", ["web"]],
    ["cd apps/api && npm ci && cd ../web && npm ci", ["apps/api", "apps/web"]],
    ["npm install && npm run build", ["."]],
    ["npm install sharp", []],
    ["npm install -D vitest", []],
    ["npm install -g typescript", []],
    ["npm install -w web", []],
    ["npm run build", []],
    ["yarn add react", []],
    ["echo hello", []],
  ])("%s", (command, expected) => {
    expect(installTargets(command)).toEqual(expected);
  });
});

describe("findRecursiveInstallScripts", () => {
  const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "europ", version: "1.0.0", scripts });

  it("finds the script of the real project", () => {
    expect(findRecursiveInstallScripts(pkg({ install: "npm install", dev: "vite" }))).toEqual([{ script: "install", command: "npm install" }]);
  });

  it("finds it in every install-time hook and with flags", () => {
    expect(findRecursiveInstallScripts(pkg({ postinstall: "npm install --legacy-peer-deps" })).map((s) => s.script)).toEqual(["postinstall"]);
    expect(findRecursiveInstallScripts(pkg({ prepare: "npm ci" })).map((s) => s.script)).toEqual(["prepare"]);
    expect(findRecursiveInstallScripts(pkg({ preinstall: "yarn" })).map((s) => s.script)).toEqual(["preinstall"]);
  });

  it("sees through one script calling another", () => {
    expect(findRecursiveInstallScripts(pkg({ postinstall: "npm run setup", setup: "npm install && npm run build" })).map((s) => s.script)).toEqual(["postinstall"]);
  });

  it("does not flag legitimate monorepo bootstrap scripts", () => {
    expect(findRecursiveInstallScripts(pkg({ postinstall: "npm --prefix web install" }))).toEqual([]);
    expect(findRecursiveInstallScripts(pkg({ postinstall: "cd web && npm install" }))).toEqual([]);
    expect(findRecursiveInstallScripts(pkg({ prepare: "husky install" }))).toEqual([]);
    expect(findRecursiveInstallScripts(pkg({ install: "node-gyp rebuild" }))).toEqual([]);
    expect(findRecursiveInstallScripts(pkg({ postinstall: "npm run build", build: "tsc" }))).toEqual([]);
    expect(findRecursiveInstallScripts(pkg({ setup: "npm install" }))).toEqual([]); // not run automatically
  });

  it("copes with invalid json and missing scripts", () => {
    expect(findRecursiveInstallScripts("{ nope")).toEqual([]);
    expect(findRecursiveInstallScripts('{"name":"x"}')).toEqual([]);
  });

  it("does not loop forever on scripts that call each other", () => {
    expect(findRecursiveInstallScripts(pkg({ postinstall: "npm run a", a: "npm run b", b: "npm run a" }))).toEqual([]);
  });
});

describe("LoopWatch", () => {
  it("stops at the third identical banner, also when the text arrives in small pieces", () => {
    const watch = new LoopWatch();
    const text = LOOP_BLOCK.repeat(4);
    let found = null;
    for (let i = 0; i < text.length && !found; i += 7) found = watch.feed(text.slice(i, i + 7));
    expect(found).toEqual({ pkg: "europ@1.0.0", script: "install", command: "npm install", count: 3 });
  });

  it("handles Windows line endings", () => {
    expect(new LoopWatch().feed(LOOP_BLOCK.repeat(3).replace(/\n/g, "\r\n"))).not.toBeNull();
  });

  it("ignores a normal install, and different packages", () => {
    const watch = new LoopWatch();
    expect(watch.feed(LOOP_BLOCK)).toBeNull();
    expect(watch.feed("> other@1.0.0 postinstall\n> node setup.js\n")).toBeNull();
    expect(watch.feed("> third@1.0.0 postinstall\n> node setup.js\n")).toBeNull();
    expect(watch.feed("> other@1.0.0 postinstall\n> node setup.js\n")).toBeNull();
  });

  it("does not count build-script banners", () => {
    const watch = new LoopWatch();
    const block = "> app@1.0.0 build\n> tsc\n\n";
    expect(watch.feed(block.repeat(5))).toBeNull();
  });

  it("findLoopInOutput works on a finished output", () => {
    expect(findLoopInOutput(LOOP_BLOCK.repeat(3))?.count).toBe(3);
    expect(findLoopInOutput(LOOP_BLOCK)).toBeNull();
  });
});

describe("isGlobalNpmUpgrade", () => {
  it.each([
    ["npm install -g npm@latest", true],
    ["npm i -g npm", true],
    ["npm install --global npm@next", true],
    ["npm update -g npm", true],
    ["cd x && npm install -g npm@latest", true],
    ["npm install -g npm@11", false],
    ["npm install -g typescript", false],
    ["npm install npm@latest", false],
    ["npm install", false],
  ])("%s -> %s", (command, expected) => {
    expect(isGlobalNpmUpgrade(command)).toBe(expected);
  });
});

describe("adviseBeforeRun", () => {
  const loopPkg = JSON.stringify({ name: "europ", scripts: { install: "npm install" } });
  const okPkg = JSON.stringify({ name: "europ", scripts: { dev: "vite" } });

  it("refuses npm install in a project with the self-calling script, and says how to fix it", () => {
    const advice = adviseBeforeRun("npm install", (dir) => (dir === "." ? loopPkg : undefined));
    expect(advice?.diagnosis.kind).toBe("install-loop");
    expect(advice?.refuse).toContain("NOT run");
    expect(advice?.refuse).toContain('scripts.install = "npm install"');
    expect(advice?.refuse).toContain("delete");
  });

  it("checks the folder the install really runs in", () => {
    const read = (dir: string) => (dir === "web" ? loopPkg : okPkg);
    expect(adviseBeforeRun("npm --prefix web install", read)?.diagnosis.kind).toBe("install-loop");
    expect(adviseBeforeRun("cd web && npm ci", read)?.diagnosis.kind).toBe("install-loop");
    expect(adviseBeforeRun("npm install", read)).toBeNull();
  });

  it("lets a healthy project and other commands through", () => {
    expect(adviseBeforeRun("npm install", () => okPkg)).toBeNull();
    expect(adviseBeforeRun("npm install", () => undefined)).toBeNull();
    expect(adviseBeforeRun("npm run build", () => loopPkg)).toBeNull();
    expect(adviseBeforeRun("npm install sharp", () => loopPkg)).toBeNull();
  });

  it("refuses the npm self-upgrade and explains why", () => {
    const advice = adviseBeforeRun("npm install -g npm@latest", () => undefined);
    expect(advice?.diagnosis.kind).toBe("global-npm-upgrade");
    expect(advice?.refuse).toContain("NOT run");
    expect(advice?.refuse).toMatch(/Do not upgrade|Skip the npm upgrade/);
    expect(adviseBeforeRun("npm install -g npm@11", () => undefined)).toBeNull();
  });
});

describe("refuseRecursiveInstallScript", () => {
  it("refuses a package.json that would loop and accepts a healthy one", () => {
    expect(refuseRecursiveInstallScript(JSON.stringify({ scripts: { install: "npm install" } }))).toContain("scripts.install");
    expect(refuseRecursiveInstallScript(JSON.stringify({ scripts: { dev: "vite", setup: "npm --prefix web install" } }))).toBeNull();
    expect(refuseRecursiveInstallScript("not json")).toBeNull();
  });
});

describe("diagnoseFailure", () => {
  it("the real engine failure: the npm self-upgrade is called what it is, with no Node upgrade demanded", () => {
    const d = diagnoseFailure({ command: "npm install -g npm@latest", output: EBADENGINE_LOG, nodePath: "/opt/homebrew/Cellar/node/24.3.0/bin/node", nodeVersion: "v24.3.0" });
    expect(d?.kind).toBe("global-npm-upgrade");
    expect(d?.userMustAct).toBe(false);
    expect(d?.facts.join("\n")).toContain("^22.22.2 || ^24.15.0 || >=26.0.0");
    expect(formatDiagnosis(d!)).toContain("Do NOT");
  });

  it("a project that needs a newer Node: exact Homebrew steps, the run stops with plain words", () => {
    const log = `npm error code EBADENGINE
npm error engine Unsupported engine
npm error engine Not compatible with your version of node/npm: vite@8.0.0
npm error notsup Required: {"node":"^22.22.2 || ^24.15.0 || >=26.0.0"}
npm error notsup Actual:   {"npm":"11.4.2","node":"v24.3.0"}`;
    const d = diagnoseFailure({ command: "npm install", output: log, nodePath: "/opt/homebrew/Cellar/node/24.3.0/bin/node" });
    expect(d?.kind).toBe("engine-mismatch");
    expect(d?.userMustAct).toBe(true);
    const text = haltText(d!);
    expect(text).toContain("brew update && brew upgrade node");
    expect(text).toContain("node@24");
    expect(text).toContain("Homebrew");
    expect(text).toContain("vite");
    expect(text).not.toContain("npm install -g npm@latest");
  });

  it("uses the manager that installed Node (nvm gets nvm commands, the agent cannot run them)", () => {
    const log = `npm error code EBADENGINE
npm error engine Not compatible with your version of node/npm: vite@8.0.0
npm error notsup Required: {"node":">=22"}
npm error notsup Actual:   {"npm":"10.0.0","node":"v20.1.0"}`;
    const d = diagnoseFailure({ command: "npm install", output: log, nodePath: "/Users/me/.nvm/versions/node/v20.1.0/bin/node" });
    expect(haltText(d!)).toContain("nvm install 22");
  });

  it("an EBADENGINE warning is not blamed for the failure", () => {
    const log = `npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: 'vite@8.0.0',
npm warn EBADENGINE   required: { node: '>=22' },
npm warn EBADENGINE   current: { node: 'v20.1.0', npm: '10.0.0' }
npm warn EBADENGINE }
npm error code E404`;
    const d = diagnoseFailure({ command: "npm install", output: log });
    expect(d?.kind).toBe("engine-warning");
    expect(d?.userMustAct).toBe(false);
  });

  it("an install loop in the output: names the exact script from package.json", () => {
    const pkg = JSON.stringify({ name: "europ", scripts: { install: "npm install" } });
    const d = diagnoseFailure({ command: "npm install", output: LOOP_BLOCK.repeat(3), readPackageJson: () => pkg });
    expect(d?.kind).toBe("install-loop");
    expect(d?.userMustAct).toBe(false);
    expect(formatDiagnosis(d!)).toContain('scripts.install = "npm install"');
  });

  it("returns null for everything else", () => {
    expect(diagnoseFailure({ command: "npm test", output: "FAIL src/a.test.ts" })).toBeNull();
  });
});
