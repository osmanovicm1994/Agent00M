import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pmPlanSchema } from "./roles";
import { describeManifest, hasOpenTasks, loadTaskManifest, openIndexes, readTaskDoc, tasksDirName, updateTask, writeTaskPlan } from "./task-store";

let ws: string;

const plan = () =>
  pmPlanSchema.parse({
    goal: "users app",
    risks: ["data loss"],
    tasks: [
      { role: "db", title: "Users schema", instructions: "Add a users table.", acceptance: ["migration runs"], contract: "users(id, email)" },
      { role: "api", title: "Users endpoints", instructions: "CRUD for users.", acceptance: ["tests pass"], dependsOn: [1] },
      { role: "design", title: "Users page", instructions: "List users.", acceptance: ["typecheck passes"], dependsOn: ["task 2"] },
    ],
  });

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "task-store-"));
  delete process.env.AGENT_TASKS_DIR;
});
afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
  delete process.env.AGENT_TASKS_DIR;
});

describe("task store", () => {
  it("writes one numbered ticket per task plus the manifest", () => {
    const { manifest } = writeTaskPlan(ws, plan());
    expect(manifest.tasks.map((t) => t.file)).toEqual(["01-db-users-schema.md", "02-api-users-endpoints.md", "03-design-users-page.md"]);
    for (const t of manifest.tasks) expect(fs.existsSync(path.join(ws, "tasks", t.file))).toBe(true);
    expect(fs.existsSync(path.join(ws, "tasks", "tasks.json"))).toBe(true);
    expect(manifest.tasks[2].dependsOn).toEqual([2]);

    const ticket = fs.readFileSync(path.join(ws, "tasks", "01-db-users-schema.md"), "utf8");
    expect(ticket).toContain("**Status:** PENDING");
    expect(ticket).toContain("users(id, email)");
    expect(ticket).toContain("- [ ] migration runs");
  });

  it("loads what it saved and rejects missing or broken manifests", () => {
    expect(loadTaskManifest(ws)).toBeNull();
    writeTaskPlan(ws, plan());
    const loaded = loadTaskManifest(ws);
    expect(loaded?.plan.tasks).toHaveLength(3);
    expect(loaded?.plan.tasks[0].contract).toBe("users(id, email)");

    fs.writeFileSync(path.join(ws, "tasks", "tasks.json"), "{ not json");
    expect(loadTaskManifest(ws)).toBeNull();
  });

  it("records progress in the manifest and mirrors the status in the ticket", () => {
    const { manifest } = writeTaskPlan(ws, plan());
    expect(openIndexes(manifest)).toEqual([0, 1, 2]);

    updateTask(ws, manifest, 0, { status: "IN_PROGRESS" });
    updateTask(ws, manifest, 0, { status: "COMPLETED", summary: "table added", note: "- DB done", filesWritten: ["prisma/schema.prisma"] });
    updateTask(ws, manifest, 1, { status: "IN_PROGRESS" });
    updateTask(ws, manifest, 1, { status: "INCOMPLETE", summary: "tests failed" });

    const again = loadTaskManifest(ws)!;
    expect(again.tasks[0]).toMatchObject({ status: "COMPLETED", attempts: 1, note: "- DB done", filesWritten: ["prisma/schema.prisma"] });
    expect(again.tasks[1]).toMatchObject({ status: "INCOMPLETE", attempts: 1 });
    expect(openIndexes(again)).toEqual([1, 2]);
    expect(hasOpenTasks(again)).toBe(true);

    const ticket = fs.readFileSync(path.join(ws, "tasks", "01-db-users-schema.md"), "utf8");
    expect(ticket).toContain("**Status:** COMPLETED");
    expect(ticket).toContain("### Attempt 1: COMPLETED");
    expect(ticket).toContain("table added");
    expect(describeManifest(again)).toContain("1 of 3 completed");
  });

  it("hands the agent the ticket as it is on disk, hand edits included", () => {
    const { manifest } = writeTaskPlan(ws, plan());
    const file = path.join(ws, "tasks", manifest.tasks[0].file);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8") + "\nExtra: use UUID primary keys.\n");
    expect(readTaskDoc(ws, manifest, 0)).toContain("use UUID primary keys");
  });

  it("archives only its own files when a new plan replaces a saved one", () => {
    writeTaskPlan(ws, plan());
    fs.writeFileSync(path.join(ws, "tasks", "my-notes.md"), "mine");
    const second = writeTaskPlan(ws, plan());
    expect(second.archivedTo).toBeDefined();
    expect(fs.existsSync(path.join(ws, second.archivedTo!, "tasks.json"))).toBe(true);
    expect(fs.existsSync(path.join(ws, second.archivedTo!, "01-db-users-schema.md"))).toBe(true);
    expect(fs.readFileSync(path.join(ws, "tasks", "my-notes.md"), "utf8")).toBe("mine");
    expect(loadTaskManifest(ws)?.tasks.every((t) => t.status === "PENDING")).toBe(true);
  });

  it("accepts a safe AGENT_TASKS_DIR and ignores an unsafe one", () => {
    process.env.AGENT_TASKS_DIR = ".agent/tasks";
    expect(tasksDirName()).toBe(".agent/tasks");
    process.env.AGENT_TASKS_DIR = "../outside";
    expect(tasksDirName()).toBe("tasks");
    process.env.AGENT_TASKS_DIR = "/etc";
    expect(tasksDirName()).toBe("tasks");
  });
});
