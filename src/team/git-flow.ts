// src/team/git-flow.ts
//
// Local git for team mode. A team run changes many files; without git there is no undo and no history of who did what.
//
//   base branch (main, or whatever you were on)       never touched by the agent
//     └─ feature/<goal>                               the whole job; every finished task is merged into it
//          └─ task/<NN>-<role>-<title>                one branch per task (sequential runs), merged with --no-ff
//
// What it does:  starts a repository when the folder has none (with a .gitignore guard first), creates the feature branch,
// gives every task its own branch and a conventional commit, merges the task into the feature branch when it ends, and
// reports the commands to review and merge the feature into your base branch.
//
// What it never does: push, force anything, reset --hard, clean, rebase, delete an unmerged branch, change the base branch,
// or touch a repository that is bigger than the project folder (the project folder must be the repository root).
// A git problem never stops the work: the first failure switches the flow off for the rest of the run and says so.
//
// Plain `git` through execFile (no shell), a timeout on every call, no prompts. AGENT_GIT=0 switches it off.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type GitLevel = "info" | "warn" | "step";

export interface GitInfo {
  /** The branch the run started from. The agent never commits to it. */
  base: string;
  /** The branch that holds the whole job. */
  feature: string;
  /** The folder had no repository and one was created. */
  created: boolean;
}

export interface GitSummary extends GitInfo {
  /** Commits on the feature branch that are not on the base branch, newest first ("abc1234 feat(api): ..."). */
  commits: string[];
  /** Task branches that were NOT merged into the feature branch (a conflict, or a crash), with the reason. */
  openBranches: string[];
  /** Plain commands the person can copy: review, then merge into the base branch. */
  commands: string[];
  /** Why the flow stopped early, when it did. */
  stoppedBecause?: string;
}

export interface GitFlowOptions {
  root: string;
  goal: string;
  /** Set on a resume: the branches of the saved plan. */
  resume?: { base: string; feature: string };
  /** Ask the person. Without it, the flow never asks and skips whatever would need an answer. */
  confirm?: (question: string) => Promise<boolean>;
  log?: (line: string, level?: GitLevel) => void;
  env?: NodeJS.ProcessEnv;
  /** The tasks folder name, kept out of git (it is the agent's own bookkeeping). */
  tasksDir?: string;
}

export type TaskOutcome = "done" | "incomplete" | "interrupted" | "skipped";

const GIT_TIMEOUT_MS = 60_000;
const IDENTITY = ["-c", "user.name=Agent CLI", "-c", "user.email=agent@localhost"];

// Kept out of git through .git/info/exclude (local to this clone: no file of yours is edited).
const EXCLUDES = ["node_modules/", ".next/", "dist/", "build/", "coverage/", ".turbo/", ".env", ".env.*", "!.env.example", "*.log", ".DS_Store"];

const STARTER_GITIGNORE = [
  "node_modules/",
  ".next/",
  "dist/",
  "build/",
  "coverage/",
  ".env",
  ".env.*",
  "!.env.example",
  "*.log",
  ".DS_Store",
  "test-results/",
  "playwright-report/",
  "",
].join("\n");

export function slug(s: string, max = 40): string {
  const t = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return t || "work";
}

const SCOPE: Record<string, string> = { db: "db", api: "api", design: "ui", dev: "app", qa: "test", infra: "infra", debug: "fix", ux: "ux" };

/** `type(scope): subject`, at most 72 characters, lowercase, no period (Conventional Commits). */
export function commitSubject(role: string, title: string, outcome: TaskOutcome = "done"): string {
  const type = outcome !== "done" ? "wip" : role === "infra" ? "chore" : role === "qa" ? "test" : role === "debug" ? "fix" : "feat";
  const scope = SCOPE[role] ?? "app";
  const head = `${type}(${scope}): `;
  const subject = title.replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "").toLowerCase();
  return head + subject.slice(0, Math.max(10, 72 - head.length)).trim();
}

export function taskBranchName(n: number, role: string, title: string): string {
  return `task/${String(n).padStart(2, "0")}-${role}-${slug(title, 36)}`;
}

export class GitFlow {
  private broken = false;
  private stopped?: string;
  private current?: { n: number; branch: string };
  private readonly open: string[] = [];
  private readonly env: NodeJS.ProcessEnv;
  private identity: string[] = [];

  private constructor(
    private readonly root: string,
    private meta: GitInfo,
    private readonly log: (line: string, level?: GitLevel) => void,
    env: NodeJS.ProcessEnv,
  ) {
    this.env = { ...env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_PAGER: "cat", LC_ALL: "C" };
    this.identity = this.git(["config", "user.email"], true) ? [] : IDENTITY;
  }

  // ---------- low level ----------

  private git(args: string[], allowFail = false): string {
    try {
      return execFileSync("git", args, { cwd: this.root, env: this.env, encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (err: any) {
      if (allowFail) return "";
      const msg = String(err?.stderr || err?.message || err).trim().split("\n")[0];
      throw new Error(`git ${args.slice(0, 2).join(" ")}: ${msg}`);
    }
  }

  private static run(root: string, args: string[], env: NodeJS.ProcessEnv, allowFail = true): string {
    try {
      return execFileSync("git", args, {
        cwd: root,
        env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_PAGER: "cat", LC_ALL: "C" },
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (err) {
      if (allowFail) return "";
      throw err;
    }
  }

  private guard<T>(what: string, fn: () => T, fallback: T): T {
    if (this.broken) return fallback;
    try {
      return fn();
    } catch (err: any) {
      this.broken = true;
      this.stopped = `${what}: ${String(err?.message ?? err)}`;
      this.log(`git workflow stopped (${this.stopped}). The work continues without git branches; nothing was lost.`, "warn");
      return fallback;
    }
  }

  private branchExists(name: string): boolean {
    return this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], true) !== "";
  }

  private currentBranch(): string {
    return this.git(["symbolic-ref", "--short", "-q", "HEAD"], true);
  }

  private isDirty(): boolean {
    return this.git(["status", "--porcelain"], true) !== "";
  }

  private commitAllRaw(message: string): boolean {
    this.git(["add", "-A"]);
    if (this.git(["diff", "--cached", "--name-only"], true) === "") return false;
    const base = [...this.identity, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message];
    try {
      this.git(base);
    } catch {
      // A hook of the project (lint, tests) refused the agent's checkpoint: record it anyway, and say so.
      this.git([...base, "--no-verify"]);
      this.log("a git hook refused a commit, so it was made with --no-verify (checkpoint of the agent's work)", "warn");
    }
    return true;
  }

  // ---------- start ----------

  /** Null when git cannot or should not be used here (the reason is logged). */
  static async start(opts: GitFlowOptions): Promise<GitFlow | null> {
    const env = opts.env ?? process.env;
    const log = opts.log ?? (() => undefined);
    if (env.AGENT_GIT === "0") return null;
    const root = opts.root;

    if (!GitFlow.run(root, ["--version"], env)) {
      log("git is not installed, so the branch workflow is skipped", "warn");
      return null;
    }

    let created = false;
    const top = GitFlow.run(root, ["rev-parse", "--show-toplevel"], env);
    if (top) {
      let same = false;
      try {
        same = fs.realpathSync(top) === fs.realpathSync(root);
      } catch {
        same = false;
      }
      if (!same) {
        log(`this folder is inside another git repository (${top}), so the branch workflow is skipped. Put the project in its own repository to use it.`, "warn");
        return null;
      }
    } else {
      if (GitFlow.run(root, ["init", "-q", "-b", "main"], env, true) === "" && !fs.existsSync(path.join(root, ".git"))) {
        GitFlow.run(root, ["init", "-q"], env);
        GitFlow.run(root, ["symbolic-ref", "HEAD", "refs/heads/main"], env);
      }
      if (!fs.existsSync(path.join(root, ".git"))) {
        log("git init failed, so the branch workflow is skipped", "warn");
        return null;
      }
      created = true;
      log("no git repository here: created one (branch main)", "step");
    }

    const flow = new GitFlow(root, { base: "", feature: "", created }, log, env);
    try {
      flow.prepare(opts.tasksDir);
    } catch (err: any) {
      log(`git setup failed (${String(err?.message ?? err)}), so the branch workflow is skipped`, "warn");
      return null;
    }

    const hasCommit = flow.git(["rev-parse", "--verify", "--quiet", "HEAD"], true) !== "";
    if (!hasCommit) {
      try {
        if (!fs.existsSync(path.join(root, ".gitignore"))) fs.writeFileSync(path.join(root, ".gitignore"), STARTER_GITIGNORE);
        flow.git(["add", "-A"]);
        flow.git([...flow.identity, "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "chore: initial commit"]);
        log("first commit made (chore: initial commit)", "step");
      } catch (err: any) {
        log(`first commit failed (${String(err?.message ?? err)}), so the branch workflow is skipped`, "warn");
        return null;
      }
    }

    const branch = flow.currentBranch();
    if (!branch) {
      log("git is on a detached HEAD, so the branch workflow is skipped (check out a branch first)", "warn");
      return null;
    }

    // ----- resume: back onto the saved feature branch -----
    if (opts.resume) {
      try {
        const { base, feature } = opts.resume;
        if (flow.branchExists(feature)) {
          if (branch !== feature) {
            if (flow.isDirty()) flow.commitAllRaw("wip: save interrupted work");
            flow.git(["checkout", "-q", feature]);
          }
          flow.meta.base = base;
          flow.meta.feature = feature;
          log(`continuing on branch ${feature} (base ${base})`, "step");
          return flow;
        }
        log(`the saved feature branch ${feature} no longer exists; a new one is created`, "warn");
      } catch (err: any) {
        log(`git could not return to the saved branch (${String(err?.message ?? err)}), so the branch workflow is skipped`, "warn");
        return null;
      }
    }

    // ----- a clean start point -----
    try {
      if (flow.isDirty()) {
        const ok = opts.confirm
          ? await opts.confirm(`You have uncommitted changes. Save them as a checkpoint commit on "${branch}" before the team starts?`)
          : false;
        if (!ok) {
          log("there are uncommitted changes, so the branch workflow is skipped (commit or stash them first, or answer yes next time)", "warn");
          return null;
        }
        flow.commitAllRaw("chore: checkpoint before team run");
        log(`your changes were saved as a checkpoint commit on ${branch}`, "step");
      }
      let feature = `feature/${slug(opts.goal)}`;
      for (let i = 2; flow.branchExists(feature); i++) feature = `feature/${slug(opts.goal, 36)}-${i}`;
      flow.git(["checkout", "-q", "-b", feature]);
      flow.meta.base = branch;
      flow.meta.feature = feature;
      log(`working on branch ${feature} (base ${branch} stays untouched)`, "step");
      return flow;
    } catch (err: any) {
      log(`git could not create the feature branch (${String(err?.message ?? err)}), so the branch workflow is skipped`, "warn");
      return null;
    }
  }

  /** Local excludes (no project file is edited): bookkeeping, dependencies, build output, secrets. */
  private prepare(tasksDir?: string): void {
    const rel = this.git(["rev-parse", "--git-path", "info/exclude"]);
    const file = path.isAbsolute(rel) ? rel : path.join(this.root, rel);
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      text = "";
    }
    const want = [...(tasksDir ? [`/${tasksDir}/`] : []), ...EXCLUDES].filter((l) => !text.split("\n").includes(l));
    if (want.length) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${text.replace(/\s*$/, "")}${text ? "\n" : ""}# added by the agent CLI\n${want.join("\n")}\n`);
    }
  }

  info(): GitInfo {
    return { ...this.meta };
  }

  // ---------- one task, one branch (sequential runs) ----------

  beginTask(n: number, role: string, title: string): void {
    this.guard(
      "start of task",
      () => {
        const branch = taskBranchName(n, role, title);
        const now = this.currentBranch();
        if (now !== this.meta.feature && now !== branch) {
          if (this.isDirty()) this.commitAllRaw("wip: save work from the previous branch");
          this.git(["checkout", "-q", this.meta.feature]);
        }
        if (this.currentBranch() !== branch) {
          if (this.branchExists(branch)) {
            // a retry or a resume: the branch holds the earlier attempt; bring it up to date with the feature branch first
            this.git(["checkout", "-q", branch]);
            this.git(["merge", "-q", "--no-edit", this.meta.feature], true);
          } else {
            this.git(["checkout", "-q", "-b", branch]);
          }
        }
        this.current = { n, branch };
      },
      undefined,
    );
  }

  /** Commits what the task wrote and merges the task branch into the feature branch. */
  endTask(n: number, role: string, title: string, outcome: TaskOutcome, filesWritten: string[] = []): void {
    this.guard(
      "end of task",
      () => {
        const cur = this.current;
        if (!cur || cur.n !== n) return;
        this.current = undefined;
        const subject = commitSubject(role, title, outcome);
        const body = `Task ${n}: ${title}${outcome === "done" ? "" : ` (${outcome})`}${filesWritten.length ? `\n\nFiles: ${filesWritten.slice(0, 20).join(", ")}${filesWritten.length > 20 ? ", ..." : ""}` : ""}`;
        this.commitAllRaw(`${subject}\n\n${body}`);

        const onTask = this.currentBranch() === cur.branch;
        if (this.currentBranch() !== this.meta.feature) this.git(["checkout", "-q", this.meta.feature]);
        if (!onTask && !this.branchExists(cur.branch)) return; // the agent switched branches itself; its work stays where it is

        const ahead = Number(this.git(["rev-list", "--count", `${this.meta.feature}..${cur.branch}`], true) || "0");
        if (ahead === 0) {
          this.git(["branch", "-d", cur.branch], true);
          return;
        }
        try {
          this.git([...this.identity, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", `merge: task ${n} ${title.slice(0, 60)}`, cur.branch]);
          this.git(["branch", "-d", cur.branch], true);
        } catch {
          this.git(["merge", "--abort"], true);
          this.open.push(`${cur.branch} (merge into ${this.meta.feature} had a conflict; review it with: git diff ${this.meta.feature}...${cur.branch})`);
          this.log(`task branch ${cur.branch} was not merged (conflict). It is kept for you.`, "warn");
        }
      },
      undefined,
    );
  }

  // ---------- parallel runs: one working folder, so commits per task by path ----------

  /** Commits the files of one finished task on the feature branch. */
  commitFiles(role: string, title: string, outcome: TaskOutcome, files: string[]): void {
    this.guard(
      "task commit",
      () => {
        if (this.currentBranch() !== this.meta.feature) this.git(["checkout", "-q", this.meta.feature]);
        const rel = files
          .map((f) => (path.isAbsolute(f) ? path.relative(this.root, f) : f))
          .filter((f) => f && !f.startsWith("..") && fs.existsSync(path.join(this.root, f)));
        if (rel.length === 0) return;
        this.git(["add", "--", ...rel]);
        if (this.git(["diff", "--cached", "--name-only"], true) === "") return;
        const message = `${commitSubject(role, title, outcome)}\n\nFiles: ${rel.slice(0, 20).join(", ")}${rel.length > 20 ? ", ..." : ""}`;
        const base = [...this.identity, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message];
        try {
          this.git(base);
        } catch {
          this.git([...base, "--no-verify"]);
        }
      },
      undefined,
    );
  }

  /** Anything left (lockfile, generated files, a repair run) goes into one commit on the feature branch. */
  commitAll(message: string): void {
    this.guard(
      "commit",
      () => {
        if (this.currentBranch() !== this.meta.feature) this.git(["checkout", "-q", this.meta.feature]);
        this.commitAllRaw(message);
      },
      undefined,
    );
  }

  // ---------- end ----------

  finish(): GitSummary {
    const base = this.meta.base;
    const feature = this.meta.feature;
    let commits: string[] = [];
    if (!this.broken) {
      this.guard(
        "finish",
        () => {
          if (this.isDirty()) this.commitAllRaw("chore: save remaining changes");
          if (this.currentBranch() !== feature) this.git(["checkout", "-q", feature]);
          commits = this.git(["log", "--format=%h %s", `${base}..${feature}`], true).split("\n").filter(Boolean);
        },
        undefined,
      );
    }
    return {
      ...this.meta,
      commits,
      openBranches: [...this.open],
      commands: [`git log --oneline ${base}..${feature}`, `git diff ${base}...${feature} --stat`, `git checkout ${base} && git merge --no-ff ${feature}`],
      ...(this.stopped ? { stoppedBecause: this.stopped } : {}),
    };
  }
}
