// Pure model of the dashboard's panel layout: a tree of splits and tab groups, plus floating windows.
// No React and no DOM in here, so it is unit-tested (model.test.ts, run by the root `npm test`).
// Every function returns a NEW layout and never changes its input.

export type PanelId = "live" | "tree" | "preview" | "prompt" | "status" | "agents" | "tokens" | "history" | "settings" | "stack" | "guide";

export const PANEL_IDS: PanelId[] = ["live", "tree", "preview", "prompt", "status", "agents", "tokens", "history", "settings", "stack", "guide"];

export const PANEL_TITLES: Record<PanelId, string> = {
  live: "Live",
  tree: "Project tree",
  preview: "Design preview",
  prompt: "Prompt",
  status: "Run status",
  agents: "Agents",
  tokens: "Tokens",
  history: "History",
  settings: "Settings",
  stack: "Stack",
  guide: "Guide",
};

// Panels that manage their own scrolling and fill the whole window. All others scroll inside their window.
export const FILL_PANELS: ReadonlySet<PanelId> = new Set<PanelId>(["live", "tree", "preview"]);

export type Side = "left" | "right" | "top" | "bottom";

export interface GroupNode {
  type: "group";
  id: string;
  tabs: PanelId[];
  active: PanelId;
}

export interface SplitNode {
  type: "split";
  id: string;
  dir: "row" | "col";
  // Relative widths (row) or heights (col); always normalized to sum 1.
  sizes: number[];
  children: LayoutNode[];
}

export type LayoutNode = GroupNode | SplitNode;

export interface FloatingWindow {
  id: string;
  panel: PanelId;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

export interface Layout {
  version: 1;
  root: LayoutNode | null;
  floating: FloatingWindow[];
}

export const MIN_SIZE = 0.08;
export const MIN_FLOAT_W = 240;
export const MIN_FLOAT_H = 160;

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function isPanelId(value: unknown): value is PanelId {
  return typeof value === "string" && (PANEL_IDS as string[]).includes(value);
}

function normalize(sizes: number[]): number[] {
  const clean = sizes.map((s) => (Number.isFinite(s) && s > 0 ? s : 0));
  const total = clean.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return clean.map(() => 1 / clean.length);
  return clean.map((s) => s / total);
}

// Removes empty groups, collapses splits with one child, merges a split into its parent when both go the same way.
function prune(node: LayoutNode | null): LayoutNode | null {
  if (!node) return null;
  if (node.type === "group") {
    if (node.tabs.length === 0) return null;
    return node.tabs.includes(node.active) ? node : { ...node, active: node.tabs[0] };
  }
  const kids: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const p = prune(child);
    if (!p) return;
    const weight = node.sizes[i] ?? 1 / node.children.length;
    if (p.type === "split" && p.dir === node.dir) {
      const total = p.sizes.reduce((a, b) => a + b, 0) || 1;
      p.children.forEach((grand, j) => {
        kids.push(grand);
        sizes.push(weight * (p.sizes[j] / total));
      });
    } else {
      kids.push(p);
      sizes.push(weight);
    }
  });
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0];
  return { ...node, children: kids, sizes: normalize(sizes) };
}

export function allGroups(node: LayoutNode | null): GroupNode[] {
  if (!node) return [];
  if (node.type === "group") return [node];
  return node.children.flatMap(allGroups);
}

export function listPanels(layout: Layout): PanelId[] {
  return [...allGroups(layout.root).flatMap((g) => g.tabs), ...layout.floating.map((f) => f.panel)];
}

export function hasPanel(layout: Layout, panel: PanelId): boolean {
  return listPanels(layout).includes(panel);
}

export function findGroupOf(layout: Layout, panel: PanelId): GroupNode | undefined {
  return allGroups(layout.root).find((g) => g.tabs.includes(panel));
}

function strip(node: LayoutNode, panel: PanelId): LayoutNode {
  if (node.type === "group") return node.tabs.includes(panel) ? { ...node, tabs: node.tabs.filter((t) => t !== panel) } : node;
  return { ...node, children: node.children.map((c) => strip(c, panel)) };
}

function mapGroup(node: LayoutNode | null, id: string, fn: (g: GroupNode) => GroupNode): LayoutNode | null {
  if (!node) return null;
  if (node.type === "group") return node.id === id ? fn(node) : node;
  return { ...node, children: node.children.map((c) => mapGroup(c, id, fn) as LayoutNode) };
}

function replaceGroup(node: LayoutNode | null, id: string, fn: (g: GroupNode) => LayoutNode): LayoutNode | null {
  if (!node) return null;
  if (node.type === "group") return node.id === id ? fn(node) : node;
  return { ...node, children: node.children.map((c) => replaceGroup(c, id, fn) as LayoutNode) };
}

function nextZ(floating: FloatingWindow[]): number {
  return floating.reduce((m, f) => Math.max(m, f.z), 0) + 1;
}

// Takes a panel out of wherever it is (a tab or a floating window). Empty groups disappear.
export function removePanel(layout: Layout, panel: PanelId): Layout {
  return {
    ...layout,
    root: prune(layout.root ? strip(layout.root, panel) : null),
    floating: layout.floating.filter((f) => f.panel !== panel),
  };
}

export const closePanel = removePanel;

function newGroup(panel: PanelId): GroupNode {
  return { type: "group", id: uid("g"), tabs: [panel], active: panel };
}

// Puts a panel into the first group (or makes it the only one).
function addAnywhere(layout: Layout, panel: PanelId): Layout {
  const first = allGroups(layout.root)[0];
  if (!first) return { ...layout, root: newGroup(panel) };
  return addTab(layout, first.id, panel);
}

// Moves a panel into a group as a tab (at `index`, or last) and makes it the active tab.
export function addTab(layout: Layout, groupId: string, panel: PanelId, index?: number): Layout {
  const target = allGroups(layout.root).find((g) => g.id === groupId);
  if (!target) return layout;
  let at = index;
  const oldIndex = target.tabs.indexOf(panel);
  if (at !== undefined && oldIndex !== -1 && oldIndex < at) at -= 1;
  const without = removePanel(layout, panel);
  const remaining = allGroups(without.root).find((g) => g.id === groupId);
  // The target held only this panel: moving it onto itself changes nothing.
  if (!remaining) return layout;
  const tabs = remaining.tabs.slice();
  const pos = at === undefined ? tabs.length : Math.max(0, Math.min(at, tabs.length));
  tabs.splice(pos, 0, panel);
  return { ...without, root: mapGroup(without.root, groupId, (g) => ({ ...g, tabs, active: panel })) };
}

// Moves a panel into a NEW group beside `targetId` (left/right = side by side, top/bottom = stacked).
export function splitGroup(layout: Layout, targetId: string, panel: PanelId, side: Side): Layout {
  const target = allGroups(layout.root).find((g) => g.id === targetId);
  if (!target) return layout;
  if (target.tabs.length === 1 && target.tabs[0] === panel) return layout;
  const without = removePanel(layout, panel);
  if (!allGroups(without.root).some((g) => g.id === targetId)) return layout;
  const fresh = newGroup(panel);
  const dir: "row" | "col" = side === "left" || side === "right" ? "row" : "col";
  const before = side === "left" || side === "top";
  const root = replaceGroup(without.root, targetId, (g) => ({
    type: "split",
    id: uid("s"),
    dir,
    sizes: [0.5, 0.5],
    children: before ? [fresh, g] : [g, fresh],
  }));
  return { ...without, root: prune(root) };
}

export function setActive(layout: Layout, groupId: string, panel: PanelId): Layout {
  return { ...layout, root: mapGroup(layout.root, groupId, (g) => (g.tabs.includes(panel) ? { ...g, active: panel } : g)) };
}

// Sets the sizes of one split (after dragging a divider).
export function setSizes(layout: Layout, splitId: string, sizes: number[]): Layout {
  const apply = (node: LayoutNode): LayoutNode => {
    if (node.type === "group") return node;
    if (node.id === splitId && sizes.length === node.children.length) return { ...node, sizes: normalize(sizes) };
    return { ...node, children: node.children.map(apply) };
  };
  return { ...layout, root: layout.root ? apply(layout.root) : null };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Pops a panel out into a floating window.
export function floatPanel(layout: Layout, panel: PanelId, rect?: Partial<Rect>): Layout {
  const without = removePanel(layout, panel);
  const n = without.floating.length;
  const win: FloatingWindow = {
    id: uid("f"),
    panel,
    x: rect?.x ?? 70 + n * 28,
    y: rect?.y ?? 70 + n * 28,
    w: Math.max(MIN_FLOAT_W, rect?.w ?? 520),
    h: Math.max(MIN_FLOAT_H, rect?.h ?? 380),
    z: nextZ(without.floating),
  };
  return { ...without, floating: [...without.floating, win] };
}

// Brings a floating window back into the layout as a tab.
export function dockPanel(layout: Layout, panel: PanelId): Layout {
  if (!layout.floating.some((f) => f.panel === panel)) return layout;
  return addAnywhere(removePanel(layout, panel), panel);
}

// Shows a panel: raises it when floating, selects its tab when docked, adds it as a tab when closed.
export function openPanel(layout: Layout, panel: PanelId): Layout {
  const win = layout.floating.find((f) => f.panel === panel);
  if (win) return raiseFloating(layout, win.id);
  const group = findGroupOf(layout, panel);
  if (group) return setActive(layout, group.id, panel);
  return addAnywhere(layout, panel);
}

export function raiseFloating(layout: Layout, id: string): Layout {
  const win = layout.floating.find((f) => f.id === id);
  if (!win || win.z === nextZ(layout.floating) - 1) return layout;
  const z = nextZ(layout.floating);
  return { ...layout, floating: layout.floating.map((f) => (f.id === id ? { ...f, z } : f)) };
}

export function moveFloating(layout: Layout, id: string, x: number, y: number): Layout {
  return { ...layout, floating: layout.floating.map((f) => (f.id === id ? { ...f, x, y } : f)) };
}

export function resizeFloating(layout: Layout, id: string, w: number, h: number): Layout {
  return {
    ...layout,
    floating: layout.floating.map((f) => (f.id === id ? { ...f, w: Math.max(MIN_FLOAT_W, w), h: Math.max(MIN_FLOAT_H, h) } : f)),
  };
}

// ---------- validation (saved layouts, imported files) ----------

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// Accepts anything: returns a clean layout, or null when the data is not a layout at all.
// Unknown panels and duplicates are dropped, so an old or hand-edited file cannot break the page.
export function validateLayout(raw: unknown): Layout | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return null;
  const seen = new Set<PanelId>();

  const readNode = (value: unknown, depth: number): LayoutNode | null => {
    if (depth > 12 || !value || typeof value !== "object") return null;
    const o = value as Record<string, unknown>;
    const id = typeof o.id === "string" && o.id ? o.id : uid(o.type === "split" ? "s" : "g");
    if (o.type === "group") {
      if (!Array.isArray(o.tabs)) return null;
      const tabs: PanelId[] = [];
      for (const t of o.tabs) {
        if (isPanelId(t) && !seen.has(t)) {
          seen.add(t);
          tabs.push(t);
        }
      }
      if (tabs.length === 0) return null;
      return { type: "group", id, tabs, active: isPanelId(o.active) && tabs.includes(o.active) ? o.active : tabs[0] };
    }
    if (o.type === "split") {
      if ((o.dir !== "row" && o.dir !== "col") || !Array.isArray(o.children)) return null;
      const kids: LayoutNode[] = [];
      const sizes: number[] = [];
      o.children.forEach((c, i) => {
        const node = readNode(c, depth + 1);
        if (!node) return;
        kids.push(node);
        const s = Array.isArray(o.sizes) ? o.sizes[i] : undefined;
        sizes.push(typeof s === "number" && Number.isFinite(s) && s > 0 ? s : 1 / (o.children as unknown[]).length);
      });
      if (kids.length === 0) return null;
      return { type: "split", id, dir: o.dir, sizes: normalize(sizes), children: kids };
    }
    return null;
  };

  const root = prune(readNode(r.root, 0));
  const floating: FloatingWindow[] = [];
  if (Array.isArray(r.floating)) {
    for (const f of r.floating) {
      if (!f || typeof f !== "object") continue;
      const o = f as Record<string, unknown>;
      if (!isPanelId(o.panel) || seen.has(o.panel)) continue;
      seen.add(o.panel);
      floating.push({
        id: typeof o.id === "string" && o.id ? o.id : uid("f"),
        panel: o.panel,
        x: num(o.x, 80),
        y: num(o.y, 80),
        w: Math.max(MIN_FLOAT_W, num(o.w, 520)),
        h: Math.max(MIN_FLOAT_H, num(o.h, 380)),
        z: num(o.z, floating.length + 1),
      });
    }
  }
  return { version: 1, root, floating };
}

// ---------- presets ----------

const group = (...tabs: PanelId[]): GroupNode => ({ type: "group", id: uid("g"), tabs, active: tabs[0] });

function split(dir: "row" | "col", parts: [LayoutNode, number][]): SplitNode {
  return { type: "split", id: uid("s"), dir, sizes: normalize(parts.map((p) => p[1])), children: parts.map((p) => p[0]) };
}

export type PresetId = "coding" | "design" | "monitor";

export const PRESETS: { id: PresetId; label: string; hint: string }[] = [
  { id: "coding", label: "Coding", hint: "Live feed big, prompt below, project tree on the right" },
  { id: "design", label: "Design", hint: "Preview big, live feed and prompt beside it" },
  { id: "monitor", label: "Monitor", hint: "Agents, live feed and status side by side" },
];

export function presetLayout(id: PresetId): Layout {
  switch (id) {
    case "design":
      return {
        version: 1,
        root: split("row", [
          [group("preview"), 0.58],
          [
            split("col", [
              [group("live"), 0.42],
              [group("prompt", "status"), 0.26],
              [group("tree", "agents", "tokens", "settings"), 0.32],
            ]),
            0.42,
          ],
        ]),
        floating: [],
      };
    case "monitor":
      return {
        version: 1,
        root: split("row", [
          [group("agents"), 0.22],
          [group("live", "history"), 0.46],
          [
            split("col", [
              [group("status", "prompt"), 0.5],
              [group("tokens", "tree", "settings"), 0.5],
            ]),
            0.32,
          ],
        ]),
        floating: [],
      };
    case "coding":
    default:
      return {
        version: 1,
        root: split("row", [
          [
            split("col", [
              [group("live", "preview"), 0.68],
              [group("prompt", "status"), 0.32],
            ]),
            0.62,
          ],
          [
            split("col", [
              [group("tree"), 0.55],
              [group("agents", "tokens", "settings"), 0.45],
            ]),
            0.38,
          ],
        ]),
        floating: [],
      };
  }
}
