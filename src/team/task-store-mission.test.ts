import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pmPlanSchema } from "./roles";
import { loadTaskManifest, writeTaskPlan } from "./task-store";

let ws: string;
const plan = () => pmPlanSchema.parse({ goal: "app", tasks: [{ role: "dev", title: "Build it", instructions: "x", acceptance: ["build exits 0"] }] });

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "task-mission-"));
  delete process.env.AGENT_TASKS_DIR;
});
afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

describe("the mission is saved with the plan", () => {
  it("keeps the original request, trimmed to its maximum, and reads it back", () => {
    const { manifest } = writeTaskPlan(ws, plan(), "x".repeat(20_000));
    expect(manifest.mission?.length).toBeLessThanOrEqual(12_000);
    expect(loadTaskManifest(ws)?.mission?.slice(0, 5)).toBe("xxxxx");
  });

  it("is left out when no mission text is given", () => {
    expect(writeTaskPlan(ws, plan()).manifest.mission).toBeUndefined();
  });

  it("a second plan archives the first one and carries its own mission", () => {
    writeTaskPlan(ws, plan(), "first request");
    const second = writeTaskPlan(ws, plan(), "second request");
    expect(second.archivedTo).toBeTruthy();
    expect(loadTaskManifest(ws)?.mission).toBe("second request");
  });
});
