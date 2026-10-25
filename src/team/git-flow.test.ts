import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GitFlow, commitSubject, slug, taskBranchName } from "./git-flow";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let root: string;
let logs: string[];
const log = (line: string) => void logs.push(line);
// A clean environment for git: no global config of the machine running the tests.
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } as NodeJS.ProcessEnv;
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: ENV }).trim();
const write = (rel: string, text = "x") => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const start = (extra: Partial<Parameters<typeof GitFlow.start>[0]> = {}) => GitFlow.start({ root, goal: "Agreements app", log, env: ENV, tasksDir: "tasks", ...extra });

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-flow-")));
  logs = [];
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("names", () => {
  it("makes short kebab-case slugs", () => {
    expect(slug("Build the Agreements App!")).toBe("build-the-agreements-app");
    expect(slug("***")).toBe("work");
    expect(slug("a".repeat(100)).length).toBeLessThanOrEqual(40);
  });

  it("writes conventional commit subjects of at most 72 characters", () => {
    expect(commitSubject("api", "Agreement API.")).toBe("feat(api): agreement api");
    expect(commitSubject("infra", "Scaffold the app")).toBe("chore(infra): scaffold the app");
    expect(commitSubject("qa", "Run the tests")).toBe("test(test): run the tests");
    expect(commitSubject("design", "Pages", "incomplete")).toBe("wip(ui): pages");
    expect(commitSubject("dev", "x".repeat(200)).length).toBeLessThanOrEqual(72);
  });

  it("names task branches with the task number", () => {
    expect(taskBranchName(3, "api", "Agreement API")).toBe("task/03-api-agreement-api");
  });
});

describe.skipIf(!hasGit)("GitFlow in a folder without a repository", () => {
  it("creates the repository, the first commit and the feature branch", async () => {
    write("README.md", "# hi");
    const flow = await start();
    expect(flow).not.toBeNull();
    expect(flow!.info()).toMatchObject({ base: "main", feature: "feature/agreements-app", created: true });
    expect(git("branch", "--show-current")).toBe("feature/agreements-app");
    expect(git("log", "--format=%s", "main")).toContain("chore: initial commit");
    expect(fs.existsSync(path.join(root, ".gitignore"))).toBe(true);
  });

  it("keeps secrets, dependencies and the tasks folder out of every commit", async () => {
    write(".env", "SECRET=1");
    write(".env.example", "SECRET=");
    write("node_modules/pkg/index.js");
    write("tasks/tasks.json", "{}");
    write("src/app.ts");
    const flow = (await start())!;
    flow.beginTask(1, "dev", "App");
    write("src/more.ts");
    write(".env.local", "SECRET=2");
    flow.endTask(1, "dev", "App", "done", ["src/more.ts"]);
    const tracked = git("ls-files").split("\n");
    expect(tracked).toContain("src/app.ts");
    expect(tracked).toContain("src/more.ts");
    expect(tracked).toContain(".env.example");
    expect(tracked).not.toContain(".env");
    expect(tracked).not.toContain(".env.local");
    expect(tracked.some((f) => f.startsWith("node_modules/"))).toBe(false);
    expect(tracked.some((f) => f.startsWith("tasks/"))).toBe(false);
  });
});

describe.skipIf(!hasGit)("GitFlow tasks", () => {
  it("gives every task its own branch, a conventional commit and a --no-ff merge into the feature branch", async () => {
    write("README.md");
    const flow = (await start())!;

    flow.beginTask(1, "db", "Agreement schema");
    expect(git("branch", "--show-current")).toBe("task/01-db-agreement-schema");
    write("prisma/schema.prisma", "model A {}");
    flow.endTask(1, "db", "Agreement schema", "done", ["prisma/schema.prisma"]);
    expect(git("branch", "--show-current")).toBe("feature/agreements-app");

    flow.beginTask(2, "api", "Agreement API");
    write("src/api.ts");
    flow.endTask(2, "api", "Agreement API", "done", ["src/api.ts"]);

    const subjects = git("log", "--format=%s", "main..feature/agreements-app");
    expect(subjects).toContain("feat(db): agreement schema");
    expect(subjects).toContain("feat(api): agreement api");
    expect(subjects).toContain("merge: task 1 Agreement schema");
    expect(git("branch", "--list", "task/*")).toBe(""); // merged task branches are deleted
    expect(git("show", "main:README.md")).toBe("x"); // the base branch is untouched...
    expect(() => git("show", "main:src/api.ts")).toThrow(); // ...and has none of the work
  });

  it("keeps the work of an incomplete task on the feature branch as a wip commit", async () => {
    const flow = (await start())!;
    flow.beginTask(1, "design", "Pages");
    write("src/page.tsx");
    flow.endTask(1, "design", "Pages", "incomplete", ["src/page.tsx"]);
    expect(git("log", "--format=%s", "-3")).toContain("wip(ui): pages");
    expect(fs.existsSync(path.join(root, "src/page.tsx"))).toBe(true);
  });

  it("makes no empty commit and no branch leftovers for a task that wrote nothing", async () => {
    const flow = (await start())!;
    const before = git("rev-list", "--count", "HEAD");
    flow.beginTask(1, "qa", "Check things");
    flow.endTask(1, "qa", "Check things", "done", []);
    expect(git("rev-list", "--count", "HEAD")).toBe(before);
    expect(git("branch", "--list", "task/*")).toBe("");
  });

  it("commits per task by path in a parallel run, and the rest in one commit", async () => {
    const flow = (await start())!;
    write("apps/web/a.ts");
    write("apps/api/b.ts");
    write("package-lock.json", "{}");
    flow.commitFiles("design", "Web part", "done", ["apps/web/a.ts"]);
    flow.commitFiles("api", "Api part", "done", ["apps/api/b.ts", "does/not/exist.ts"]);
    flow.commitAll("chore: save remaining changes from the parallel run");
    const subjects = git("log", "--format=%s", "-4");
    expect(subjects).toContain("feat(ui): web part");
    expect(subjects).toContain("feat(api): api part");
    expect(subjects).toContain("chore: save remaining changes from the parallel run");
    expect(git("show", "--name-only", "--format=", "HEAD~1")).toBe("apps/api/b.ts");
  });

  it("finish() lists the commits and the commands to review and merge, and stays on the feature branch", async () => {
    const flow = (await start())!;
    flow.beginTask(1, "dev", "Thing");
    write("src/x.ts");
    flow.endTask(1, "dev", "Thing", "done", ["src/x.ts"]);
    write("src/left-over.ts");
    const s = flow.finish();
    expect(s.commits.some((c) => c.includes("feat(app): thing"))).toBe(true);
    expect(s.commits.some((c) => c.includes("chore: save remaining changes"))).toBe(true);
    expect(s.commands.join("\n")).toContain("git checkout main && git merge --no-ff feature/agreements-app");
    expect(git("branch", "--show-current")).toBe("feature/agreements-app");
    expect(git("status", "--porcelain")).toBe("");
  });
});

describe.skipIf(!hasGit)("GitFlow in an existing repository", () => {
  const init = () => {
    git("init", "-q", "-b", "develop");
    git("config", "user.email", "me@example.com");
    git("config", "user.name", "Me");
    write("a.txt", "a");
    git("add", "-A");
    git("commit", "-q", "-m", "first");
  };

  it("cuts the feature branch from the current branch and leaves it alone", async () => {
    init();
    const flow = (await start())!;
    expect(flow.info()).toMatchObject({ base: "develop", feature: "feature/agreements-app", created: false });
    expect(git("rev-parse", "develop")).toBe(git("rev-parse", "HEAD"));
  });

  it("picks a new name when the feature branch already exists", async () => {
    init();
    git("branch", "feature/agreements-app");
    const flow = (await start())!;
    expect(flow.info().feature).toBe("feature/agreements-app-2");
  });

  it("skips the whole flow when there are uncommitted changes and nobody can be asked", async () => {
    init();
    write("a.txt", "changed");
    expect(await start()).toBeNull();
    expect(logs.join("\n")).toContain("uncommitted changes");
    expect(git("branch", "--show-current")).toBe("develop");
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("changed");
  });

  it("saves the changes as a checkpoint commit when the person says yes", async () => {
    init();
    write("a.txt", "changed");
    const flow = await start({ confirm: async () => true });
    expect(flow).not.toBeNull();
    expect(git("log", "--format=%s", "develop", "-1")).toBe("chore: checkpoint before team run");
  });

  it("does nothing when the person says no", async () => {
    init();
    write("a.txt", "changed");
    expect(await start({ confirm: async () => false })).toBeNull();
    expect(git("log", "--format=%s", "-1")).toBe("first");
  });

  it("is switched off by AGENT_GIT=0", async () => {
    init();
    expect(await start({ env: { ...ENV, AGENT_GIT: "0" } })).toBeNull();
    expect(git("branch", "--show-current")).toBe("develop");
  });

  it("skips a project folder that lives inside a bigger repository", async () => {
    init();
    const inner = path.join(root, "packages", "app");
    fs.mkdirSync(inner, { recursive: true });
    const flow = await GitFlow.start({ root: inner, goal: "x", log, env: ENV });
    expect(flow).toBeNull();
    expect(logs.join("\n")).toContain("inside another git repository");
  });

  it("commits with the identity of the person when git has one", async () => {
    init();
    const flow = (await start())!;
    flow.beginTask(1, "dev", "T");
    write("b.txt");
    flow.endTask(1, "dev", "T", "done", ["b.txt"]);
    expect(git("log", "--format=%an", "-1", "--no-merges")).toBe("Me");
  });
});

describe.skipIf(!hasGit)("GitFlow resume", () => {
  it("returns to the saved feature branch and saves interrupted work first", async () => {
    write("README.md");
    const flow = (await start())!;
    const info = flow.info();
    flow.beginTask(1, "api", "Interrupted task");
    write("src/half.ts");
    // the process dies here: no endTask. A new run resumes.
    const again = (await start({ resume: { base: info.base, feature: info.feature } }))!;
    expect(again.info().feature).toBe(info.feature);
    expect(git("branch", "--show-current")).toBe(info.feature);
    expect(git("log", "--format=%s", "task/01-api-interrupted-task", "-1")).toBe("wip: save interrupted work");
    // the retry reuses the task branch and sees the earlier work
    again.beginTask(1, "api", "Interrupted task");
    expect(git("branch", "--show-current")).toBe("task/01-api-interrupted-task");
    expect(fs.existsSync(path.join(root, "src/half.ts"))).toBe(true);
    again.endTask(1, "api", "Interrupted task", "done", ["src/half.ts"]);
    expect(git("branch", "--list", "task/*")).toBe("");
    expect(git("ls-tree", "-r", "--name-only", info.feature)).toContain("src/half.ts");
  });
});
