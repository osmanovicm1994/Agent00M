import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PlanStore, applyPlanUpdate, describePlan, emptyPlan, nextStep, openSteps, parsePlan, planToolSchema, renderPlan } from "./plan";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

describe("applyPlanUpdate", () => {
  it("sets steps, cleans numbering and checkboxes the model may add, and ticks steps", () => {
    const { plan } = applyPlanUpdate(emptyPlan(), { goal: "Todo app", steps: ["1. Scaffold", "- [ ] 2) API", "Tests"], done: [1] });
    expect(plan.steps.map((s) => s.text)).toEqual(["Scaffold", "API", "Tests"]);
    expect(plan.steps.map((s) => s.done)).toEqual([true, false, false]);
    expect(plan.goal).toBe("Todo app");
    expect(nextStep(plan)).toBe(2);
  });

  it("keeps finished steps done when the list is rewritten with the same text", () => {
    const first = applyPlanUpdate(emptyPlan(), { steps: ["A", "B"], done: [1] }).plan;
    const second = applyPlanUpdate(first, { steps: ["a", "B", "C"] }).plan;
    expect(second.steps.map((s) => s.done)).toEqual([true, false, false]);
  });

  it("reopens steps, warns about unknown numbers and accepts a single number or a newline list", () => {
    const base = applyPlanUpdate(emptyPlan(), { steps: "one\ntwo", done: 1 }).plan;
    expect(base.steps).toHaveLength(2);
    expect(base.steps[0].done).toBe(true);
    const r = applyPlanUpdate(base, { reopen: [1], done: [9] });
    expect(r.plan.steps[0].done).toBe(false);
    expect(r.warnings[0]).toContain("Step 9");
  });

  it("caps steps and notes and does not mutate its input", () => {
    const many = Array.from({ length: 200 }, (_, i) => `step ${i}`);
    const r = applyPlanUpdate(emptyPlan(), { steps: many });
    expect(r.plan.steps).toHaveLength(150);
    expect(r.warnings.length).toBeGreaterThan(0);
    let p = emptyPlan();
    for (let i = 0; i < 20; i++) p = applyPlanUpdate(p, { note: `n${i}` }).plan;
    expect(p.notes).toHaveLength(12);
    expect(p.notes[11]).toBe("n19");
    const before = applyPlanUpdate(emptyPlan(), { steps: ["x"] }).plan;
    applyPlanUpdate(before, { done: [1] });
    expect(before.steps[0].done).toBe(false);
  });
});

describe("render / parse", () => {
  it("round-trips through markdown", () => {
    const plan = applyPlanUpdate(emptyPlan(), { goal: "G", steps: ["A", "B"], done: [2], note: "use Neon pooled url" }).plan;
    const parsed = parsePlan(renderPlan(plan));
    expect(parsed).toEqual(plan);
  });

  it("describes progress and the next step, and says when everything is done", () => {
    const plan = applyPlanUpdate(emptyPlan(), { steps: ["A", "B"], done: [1] }).plan;
    expect(describePlan(plan)).toContain("1/2 done. Next: step 2.");
    expect(openSteps(plan)).toEqual([{ n: 2, text: "B" }]);
    const finished = applyPlanUpdate(plan, { done: [2] }).plan;
    expect(describePlan(finished)).toContain("All 2 steps are done");
    expect(describePlan(emptyPlan())).toContain("no steps");
  });
});

describe("PlanStore", () => {
  it("saves under .agent, keeps it out of git, loads it back, and returns null when missing", () => {
    const root = tmp();
    const store = new PlanStore(root);
    expect(store.load()).toBeNull();
    const plan = applyPlanUpdate(emptyPlan(), { steps: ["A", "B"], done: [1] }).plan;
    store.save(plan);
    expect(fs.readFileSync(path.join(root, ".agent", ".gitignore"), "utf8")).toBe("*\n");
    expect(store.load()).toEqual(plan);
  });

  it("treats an unreadable or step-less file as no plan", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, ".agent"));
    fs.writeFileSync(path.join(root, ".agent", "plan.md"), "just some text\n");
    expect(new PlanStore(root).load()).toBeNull();
  });

  it("exposes one tool schema named update_plan", () => {
    expect(planToolSchema.name).toBe("update_plan");
  });
});
