import { describe, expect, it } from "vitest";
import {
  addTab,
  allGroups,
  closePanel,
  dockPanel,
  findGroupOf,
  floatPanel,
  hasPanel,
  listPanels,
  openPanel,
  PANEL_IDS,
  presetLayout,
  PRESETS,
  raiseFloating,
  resizeFloating,
  setActive,
  setSizes,
  splitGroup,
  validateLayout,
  type Layout,
  type LayoutNode,
} from "./model";

function sizesOk(node: LayoutNode | null): boolean {
  if (!node || node.type === "group") return true;
  const sum = node.sizes.reduce((a, b) => a + b, 0);
  return node.sizes.length === node.children.length && Math.abs(sum - 1) < 1e-9 && node.children.length >= 2 && node.children.every(sizesOk);
}

function expectHealthy(layout: Layout): void {
  const panels = listPanels(layout);
  expect(new Set(panels).size).toBe(panels.length); // no panel twice
  expect(sizesOk(layout.root)).toBe(true);
  for (const g of allGroups(layout.root)) {
    expect(g.tabs.length).toBeGreaterThan(0);
    expect(g.tabs).toContain(g.active);
  }
}

describe("presets", () => {
  it("are healthy and never repeat a panel", () => {
    for (const p of PRESETS) expectHealthy(presetLayout(p.id));
  });

  it("every panel can be reached: docked in a preset or openable", () => {
    const layout = presetLayout("coding");
    for (const id of PANEL_IDS) expect(hasPanel(openPanel(layout, id), id)).toBe(true);
  });
});

describe("closePanel", () => {
  it("removes the panel and collapses empty groups and single-child splits", () => {
    const layout = presetLayout("coding");
    const next = closePanel(layout, "tree");
    expect(hasPanel(next, "tree")).toBe(false);
    expectHealthy(next);
    expect(hasPanel(next, "agents")).toBe(true);
  });

  it("closing everything leaves an empty layout", () => {
    let layout = presetLayout("design");
    for (const id of PANEL_IDS) layout = closePanel(layout, id);
    expect(layout.root).toBeNull();
    expect(layout.floating).toEqual([]);
  });

  it("does not change its input", () => {
    const layout = presetLayout("coding");
    const copy = JSON.stringify(layout);
    closePanel(layout, "live");
    expect(JSON.stringify(layout)).toBe(copy);
  });
});

describe("addTab", () => {
  it("moves a panel into another group as the active tab", () => {
    const layout = presetLayout("coding");
    const target = findGroupOf(layout, "tree")!;
    const next = addTab(layout, target.id, "prompt");
    const g = findGroupOf(next, "prompt")!;
    expect(g.id).toBe(target.id);
    expect(g.active).toBe("prompt");
    expect(g.tabs).toEqual(["tree", "prompt"]);
    expectHealthy(next);
  });

  it("reorders inside the same group", () => {
    const layout = presetLayout("coding");
    const g = findGroupOf(layout, "agents")!; // agents, tokens, settings
    const next = addTab(layout, g.id, "agents", 3);
    expect(findGroupOf(next, "agents")!.tabs).toEqual(["tokens", "settings", "agents"]);
    const back = addTab(next, g.id, "agents", 0);
    expect(findGroupOf(back, "agents")!.tabs).toEqual(["agents", "tokens", "settings"]);
  });

  it("is a no-op when a lone tab is dropped on its own group", () => {
    const layout = presetLayout("coding");
    const g = findGroupOf(layout, "tree")!;
    expect(addTab(layout, g.id, "tree")).toEqual(layout);
  });

  it("ignores an unknown group", () => {
    const layout = presetLayout("coding");
    expect(addTab(layout, "nope", "live")).toBe(layout);
  });
});

describe("splitGroup", () => {
  it("puts the panel in a new group on the chosen side", () => {
    const layout = presetLayout("coding");
    const live = findGroupOf(layout, "live")!; // live, preview
    const next = splitGroup(layout, live.id, "preview", "right");
    expectHealthy(next);
    expect(findGroupOf(next, "preview")!.tabs).toEqual(["preview"]);
    expect(findGroupOf(next, "live")!.tabs).toEqual(["live"]);
  });

  it("is a no-op for a lone tab on its own group", () => {
    const layout = presetLayout("coding");
    const g = findGroupOf(layout, "tree")!;
    expect(splitGroup(layout, g.id, "tree", "left")).toBe(layout);
  });

  it("can take a panel from one group and split another", () => {
    const layout = presetLayout("coding");
    const tree = findGroupOf(layout, "tree")!;
    const next = splitGroup(layout, tree.id, "tokens", "bottom");
    expectHealthy(next);
    expect(findGroupOf(next, "tokens")!.id).not.toBe(findGroupOf(next, "agents")!.id);
  });

  it("keeps sizes valid after many splits and closes", () => {
    let layout = presetLayout("monitor");
    const sides = ["left", "right", "top", "bottom"] as const;
    PANEL_IDS.forEach((id, i) => {
      layout = openPanel(layout, id);
      const targets = allGroups(layout.root);
      layout = splitGroup(layout, targets[i % targets.length].id, id, sides[i % 4]);
      expectHealthy(layout);
    });
    for (const id of PANEL_IDS.slice(0, 5)) {
      layout = closePanel(layout, id);
      expectHealthy(layout);
    }
  });
});

describe("setSizes / setActive", () => {
  it("normalizes sizes and ignores a wrong length", () => {
    const layout = presetLayout("coding");
    const root = layout.root!;
    if (root.type !== "split") throw new Error("expected split");
    const next = setSizes(layout, root.id, [3, 1]);
    expect((next.root as typeof root).sizes).toEqual([0.75, 0.25]);
    expect(setSizes(layout, root.id, [1, 1, 1]).root).toEqual(layout.root);
  });

  it("switches the active tab only to a tab of that group", () => {
    const layout = presetLayout("coding");
    const g = findGroupOf(layout, "live")!;
    expect(findGroupOf(setActive(layout, g.id, "preview"), "live")!.active).toBe("preview");
    expect(findGroupOf(setActive(layout, g.id, "tree"), "live")!.active).toBe("live");
  });
});

describe("floating windows", () => {
  it("float and dock round trip keeps the panel exactly once", () => {
    const layout = presetLayout("coding");
    const floated = floatPanel(layout, "tree", { x: 10, y: 20, w: 300, h: 200 });
    expect(floated.floating).toHaveLength(1);
    expect(findGroupOf(floated, "tree")).toBeUndefined();
    expectHealthy(floated);
    const docked = dockPanel(floated, "tree");
    expect(docked.floating).toHaveLength(0);
    expect(findGroupOf(docked, "tree")).toBeDefined();
    expectHealthy(docked);
  });

  it("enforces a minimum size and raises the focused window", () => {
    let layout = floatPanel(presetLayout("coding"), "tree", { w: 10, h: 10 });
    layout = floatPanel(layout, "agents");
    const [a, b] = layout.floating;
    expect(a.w).toBeGreaterThanOrEqual(240);
    expect(b.z).toBeGreaterThan(a.z);
    const raised = raiseFloating(layout, a.id);
    expect(raised.floating.find((f) => f.id === a.id)!.z).toBeGreaterThan(raised.floating.find((f) => f.id === b.id)!.z);
    expect(resizeFloating(raised, a.id, 5, 5).floating.find((f) => f.id === a.id)!.h).toBeGreaterThanOrEqual(160);
  });

  it("openPanel raises a floating panel instead of duplicating it", () => {
    const layout = floatPanel(presetLayout("coding"), "tree");
    const next = openPanel(layout, "tree");
    expect(listPanels(next).filter((p) => p === "tree")).toHaveLength(1);
  });

  it("dockPanel on a docked panel changes nothing", () => {
    const layout = presetLayout("coding");
    expect(dockPanel(layout, "live")).toBe(layout);
  });
});

describe("openPanel", () => {
  it("adds a closed panel as a tab and selects it", () => {
    const layout = presetLayout("coding");
    expect(hasPanel(layout, "guide")).toBe(false);
    const next = openPanel(layout, "guide");
    expect(findGroupOf(next, "guide")!.active).toBe("guide");
    expectHealthy(next);
  });

  it("works on an empty layout", () => {
    const next = openPanel({ version: 1, root: null, floating: [] }, "live");
    expect(findGroupOf(next, "live")).toBeDefined();
  });
});

describe("validateLayout", () => {
  it("accepts a preset after a JSON round trip", () => {
    const layout = presetLayout("design");
    const back = validateLayout(JSON.parse(JSON.stringify(layout)));
    expect(back).toEqual(layout);
  });

  it("rejects things that are not layouts", () => {
    expect(validateLayout(null)).toBeNull();
    expect(validateLayout("x")).toBeNull();
    expect(validateLayout({ version: 2, root: null, floating: [] })).toBeNull();
  });

  it("drops unknown and duplicate panels and repairs sizes and active tabs", () => {
    const messy = {
      version: 1,
      root: {
        type: "split",
        dir: "row",
        sizes: [5, -1, "x"],
        children: [
          { type: "group", id: "a", tabs: ["live", "bogus", "live", "tree"], active: "nope" },
          { type: "group", id: "b", tabs: ["tree", "prompt"], active: "prompt" },
          { type: "group", id: "c", tabs: ["bogus"], active: "bogus" },
        ],
      },
      floating: [
        { panel: "prompt", x: 1, y: 2, w: 1, h: 1, z: 1 },
        { panel: "agents", x: "bad", y: 2, w: 400, h: 300, z: 2 },
        { panel: "agents", x: 0, y: 0, w: 400, h: 300, z: 3 },
        { panel: "nothing" },
      ],
    };
    const fixed = validateLayout(messy)!;
    expectHealthy(fixed);
    expect(findGroupOf(fixed, "live")!.tabs).toEqual(["live", "tree"]);
    expect(findGroupOf(fixed, "live")!.active).toBe("live");
    expect(findGroupOf(fixed, "prompt")!.tabs).toEqual(["prompt"]);
    expect(fixed.floating.map((f) => f.panel)).toEqual(["agents"]);
    expect(fixed.floating[0].x).toBe(80);
  });

  it("stops at absurd nesting depth instead of recursing forever", () => {
    let node: unknown = { type: "group", tabs: ["live"], active: "live" };
    for (let i = 0; i < 40; i++) node = { type: "split", dir: "row", sizes: [1], children: [node] };
    const out = validateLayout({ version: 1, root: node, floating: [] });
    expect(out).not.toBeNull();
    expect(out!.root).toBeNull();
  });
});
