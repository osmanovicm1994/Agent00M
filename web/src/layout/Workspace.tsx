import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  FILL_PANELS,
  MIN_SIZE,
  PANEL_TITLES,
  type FloatingWindow,
  type GroupNode,
  type Layout,
  type LayoutNode,
  type PanelId,
  type Rect,
  type Side,
  type SplitNode,
} from "./model";

// Everything the layout can do. The hook in useLayout.ts implements it on top of the pure model.
export interface LayoutActions {
  setActive: (groupId: string, panel: PanelId) => void;
  setSizes: (splitId: string, sizes: number[]) => void;
  moveTab: (panel: PanelId, groupId: string, index?: number) => void;
  splitWith: (panel: PanelId, groupId: string, side: Side) => void;
  float: (panel: PanelId, rect?: Partial<Rect>) => void;
  dock: (panel: PanelId) => void;
  close: (panel: PanelId) => void;
  open: (panel: PanelId) => void;
  raise: (id: string) => void;
  moveFloating: (id: string, x: number, y: number) => void;
  resizeFloating: (id: string, w: number, h: number) => void;
}

type Drop =
  | { kind: "tabs"; groupId: string; index: number; x: number; top: number; height: number }
  | { kind: "zone"; groupId: string; zone: Side | "center"; rect: DOMRect }
  | { kind: "root" }
  | null;

interface Env {
  renderPanel: (id: PanelId) => ReactNode;
  actions: LayoutActions;
  startDrag: (panel: PanelId, e: ReactPointerEvent) => void;
  consumeClick: () => boolean;
  getBounds: () => DOMRect | null;
}

const DRAG_START_PX = 6;
const EDGE = 0.25;

function GroupMenu({ group, env }: { group: GroupNode; env: Env }) {
  const [open, setOpen] = useState(false);
  const panel = group.active;
  const lone = group.tabs.length === 1;
  const item = "block min-h-9 w-full px-3 text-left text-xs text-slate-200 hover:bg-slate-800 disabled:text-slate-600 disabled:hover:bg-transparent";
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div className="relative shrink-0">
      <button type="button" aria-label={`Options for ${PANEL_TITLES[panel]}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} className="min-h-9 px-3 text-slate-400 hover:text-slate-100">
        ⋯
      </button>
      {open && (
        <>
          <button type="button" aria-label="Close menu" onClick={() => setOpen(false)} className="fixed inset-0 z-30 cursor-default" />
          <div role="menu" className="absolute right-0 top-full z-40 mt-1 w-48 overflow-hidden rounded-lg border border-slate-700 bg-slate-900 shadow-xl">
            <button role="menuitem" type="button" className={item} onClick={run(() => env.actions.float(panel))}>
              Pop out as window
            </button>
            <button role="menuitem" type="button" className={item} disabled={lone} onClick={run(() => env.actions.splitWith(panel, group.id, "right"))}>
              Move to the right
            </button>
            <button role="menuitem" type="button" className={item} disabled={lone} onClick={run(() => env.actions.splitWith(panel, group.id, "bottom"))}>
              Move below
            </button>
            <button role="menuitem" type="button" className={item} onClick={run(() => env.actions.close(panel))}>
              Close “{PANEL_TITLES[panel]}”
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function PanelBody({ panel, env, hidden }: { panel: PanelId; env: Env; hidden?: boolean }) {
  return (
    <div hidden={hidden} className={`h-full min-h-0 ${FILL_PANELS.has(panel) ? "overflow-hidden" : "overflow-y-auto p-3"}`}>
      {env.renderPanel(panel)}
    </div>
  );
}

function GroupView({ group, env }: { group: GroupNode; env: Env }) {
  return (
    <div data-dock-group={group.id} className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60">
      <div data-dock-tabbar role="tablist" aria-label="Panels" className="flex shrink-0 items-stretch border-b border-slate-800 bg-slate-950/50">
        <div className="flex min-w-0 flex-1 overflow-x-auto">
          {group.tabs.map((tab) => {
            const active = tab === group.active;
            return (
              <button
                key={tab}
                data-dock-tab={tab}
                type="button"
                role="tab"
                aria-selected={active}
                onPointerDown={(e) => env.startDrag(tab, e)}
                onClick={() => {
                  if (!env.consumeClick()) env.actions.setActive(group.id, tab);
                }}
                title="Click to show, drag to move"
                className={`min-h-9 shrink-0 cursor-grab touch-none whitespace-nowrap border-b-2 px-3 text-xs font-medium ${active ? "border-teal-300 text-teal-300" : "border-transparent text-slate-400 hover:text-slate-200"}`}
              >
                {PANEL_TITLES[tab]}
              </button>
            );
          })}
        </div>
        <GroupMenu group={group} env={env} />
      </div>
      <div className="min-h-0 flex-1">
        {group.tabs.map((tab) => (
          <PanelBody key={tab} panel={tab} env={env} hidden={tab !== group.active} />
        ))}
      </div>
    </div>
  );
}

function SplitView({ node, env }: { node: SplitNode; env: Env }) {
  const ref = useRef<HTMLDivElement>(null);
  const row = node.dir === "row";

  const resize = useCallback(
    (index: number, start: number[], deltaFraction: number) => {
      const pair = start[index] + start[index + 1];
      const a = Math.max(MIN_SIZE, Math.min(pair - MIN_SIZE, start[index] + deltaFraction));
      const next = start.slice();
      next[index] = a;
      next[index + 1] = pair - a;
      env.actions.setSizes(node.id, next);
    },
    [env.actions, node.id],
  );

  const onPointerDown = (index: number, e: ReactPointerEvent) => {
    const el = ref.current;
    if (!el) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const total = row ? rect.width : rect.height;
    if (total <= 0) return;
    const origin = row ? e.clientX : e.clientY;
    const start = node.sizes.slice();
    document.body.classList.add("dock-resizing");
    const onMove = (ev: PointerEvent) => resize(index, start, ((row ? ev.clientX : ev.clientY) - origin) / total);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("dock-resizing");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onKeyDown = (index: number, e: ReactKeyboardEvent) => {
    const less = row ? "ArrowLeft" : "ArrowUp";
    const more = row ? "ArrowRight" : "ArrowDown";
    if (e.key !== less && e.key !== more) return;
    e.preventDefault();
    resize(index, node.sizes, e.key === more ? 0.03 : -0.03);
  };

  return (
    <div ref={ref} className={`flex h-full min-h-0 w-full min-w-0 ${row ? "flex-row" : "flex-col"}`}>
      {node.children.map((child, i) => (
        <div key={child.type === "group" ? child.id : child.id} className="contents">
          {i > 0 && (
            <div
              role="separator"
              tabIndex={0}
              aria-orientation={row ? "vertical" : "horizontal"}
              aria-label="Resize panels (arrow keys)"
              aria-valuenow={Math.round(node.sizes[i - 1] * 100)}
              onPointerDown={(e) => onPointerDown(i - 1, e)}
              onKeyDown={(e) => onKeyDown(i - 1, e)}
              className={`shrink-0 touch-none rounded bg-transparent hover:bg-teal-300/40 focus-visible:bg-teal-300/60 ${row ? "w-1.5 cursor-col-resize" : "h-1.5 cursor-row-resize"}`}
            />
          )}
          <div style={{ flex: `${node.sizes[i]} 1 0%` }} className="min-h-0 min-w-0">
            <NodeView node={child} env={env} />
          </div>
        </div>
      ))}
    </div>
  );
}

function NodeView({ node, env }: { node: LayoutNode; env: Env }) {
  return node.type === "group" ? <GroupView group={node} env={env} /> : <SplitView node={node} env={env} />;
}

function FloatingView({ win, env }: { win: FloatingWindow; env: Env }) {
  const startMove = (e: ReactPointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const { x, y, w } = win;
    document.body.classList.add("dock-dragging");
    const onMove = (ev: PointerEvent) => {
      const b = env.getBounds();
      const maxX = b ? b.width - 80 : 4000;
      const maxY = b ? b.height - 36 : 4000;
      env.actions.moveFloating(win.id, Math.max(80 - w, Math.min(maxX, x + ev.clientX - x0)), Math.max(0, Math.min(maxY, y + ev.clientY - y0)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("dock-dragging");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const { w, h } = win;
    document.body.classList.add("dock-resizing");
    const onMove = (ev: PointerEvent) => env.actions.resizeFloating(win.id, w + ev.clientX - x0, h + ev.clientY - y0);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("dock-resizing");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const small = "min-h-8 rounded px-2 text-xs text-slate-300 hover:bg-slate-800";
  return (
    <div
      data-floating={win.id}
      role="dialog"
      aria-label={PANEL_TITLES[win.panel]}
      onPointerDown={() => env.actions.raise(win.id)}
      style={{ left: win.x, top: win.y, width: win.w, height: win.h, zIndex: 20 + win.z }}
      className="absolute flex flex-col overflow-hidden rounded-xl border border-slate-600 bg-slate-900 shadow-2xl"
    >
      <div onPointerDown={startMove} className="flex shrink-0 cursor-grab touch-none items-center justify-between bg-slate-950 pl-3 pr-1 text-xs font-medium text-slate-200">
        <span className="truncate">{PANEL_TITLES[win.panel]}</span>
        <span className="flex shrink-0">
          <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => env.actions.dock(win.panel)} className={small}>
            Dock
          </button>
          <button type="button" aria-label={`Close ${PANEL_TITLES[win.panel]}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => env.actions.close(win.panel)} className={small}>
            ✕
          </button>
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <PanelBody panel={win.panel} env={env} />
      </div>
      <div aria-hidden onPointerDown={startResize} className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize touch-none" />
    </div>
  );
}

// Highlight shown while a tab is dragged: where it would land.
function DropOverlay({ drop }: { drop: Exclude<Drop, null> }) {
  if (drop.kind === "root") return null;
  if (drop.kind === "tabs") {
    return <div style={{ position: "fixed", left: drop.x - 1.5, top: drop.top, width: 3, height: drop.height }} className="pointer-events-none z-50 rounded bg-teal-300" />;
  }
  const { rect, zone } = drop;
  const box =
    zone === "center"
      ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      : zone === "left"
        ? { left: rect.left, top: rect.top, width: rect.width / 2, height: rect.height }
        : zone === "right"
          ? { left: rect.left + rect.width / 2, top: rect.top, width: rect.width / 2, height: rect.height }
          : zone === "top"
            ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height / 2 }
            : { left: rect.left, top: rect.top + rect.height / 2, width: rect.width, height: rect.height / 2 };
  return <div style={{ position: "fixed", ...box }} className="pointer-events-none z-50 rounded-xl border-2 border-teal-300 bg-teal-300/15" />;
}

interface Props {
  layout: Layout;
  actions: LayoutActions;
  renderPanel: (id: PanelId) => ReactNode;
}

// The docking area: split panes with draggable dividers, tab groups, and floating windows.
// Drag a tab onto the middle of a group to join it, onto an edge to split, or onto a tab bar to reorder.
export function Workspace({ layout, actions, renderPanel }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const suppress = useRef(false);
  const [drag, setDrag] = useState<{ panel: PanelId; x: number; y: number; drop: Drop } | null>(null);
  const hasRoot = layout.root !== null;

  const hitTest = useCallback(
    (x: number, y: number): Drop => {
      const container = rootRef.current;
      if (!container) return null;
      const cr = container.getBoundingClientRect();
      if (x < cr.left || x > cr.right || y < cr.top || y > cr.bottom) return null;
      const els = document.elementsFromPoint(x, y) as HTMLElement[];
      if (els.some((el) => el.dataset?.floating)) return null;
      const groupEl = els.find((el) => el.dataset?.dockGroup);
      if (!groupEl) return hasRoot ? null : { kind: "root" };
      const groupId = groupEl.dataset.dockGroup as string;
      const rect = groupEl.getBoundingClientRect();
      const bar = groupEl.querySelector<HTMLElement>("[data-dock-tabbar]");
      if (bar) {
        const br = bar.getBoundingClientRect();
        if (y >= br.top && y <= br.bottom) {
          const tabs = Array.from(bar.querySelectorAll<HTMLElement>("[data-dock-tab]"));
          let index = tabs.length;
          for (let i = 0; i < tabs.length; i++) {
            const r = tabs[i].getBoundingClientRect();
            if (x < r.left + r.width / 2) {
              index = i;
              break;
            }
          }
          const last = tabs[tabs.length - 1];
          const mx = index < tabs.length ? tabs[index].getBoundingClientRect().left : last ? last.getBoundingClientRect().right : br.left;
          return { kind: "tabs", groupId, index, x: mx, top: br.top, height: br.height };
        }
      }
      const rx = (x - rect.left) / rect.width;
      const ry = (y - rect.top) / rect.height;
      const near: [Side, number][] = [
        ["left", rx],
        ["right", 1 - rx],
        ["top", ry],
        ["bottom", 1 - ry],
      ];
      near.sort((a, b) => a[1] - b[1]);
      return near[0][1] < EDGE ? { kind: "zone", groupId, zone: near[0][0], rect } : { kind: "zone", groupId, zone: "center", rect };
    },
    [hasRoot],
  );

  const startDrag = useCallback(
    (panel: PanelId, e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      const x0 = e.clientX;
      const y0 = e.clientY;
      let started = false;

      const stop = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("keydown", onKey);
        document.body.classList.remove("dock-dragging");
      };
      function onMove(ev: PointerEvent) {
        if (!started) {
          if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_START_PX) return;
          started = true;
          document.body.classList.add("dock-dragging");
        }
        setDrag({ panel, x: ev.clientX, y: ev.clientY, drop: hitTest(ev.clientX, ev.clientY) });
      }
      function onUp(ev: PointerEvent) {
        stop();
        if (!started) return;
        suppress.current = true;
        setTimeout(() => {
          suppress.current = false;
        }, 0);
        const drop = hitTest(ev.clientX, ev.clientY);
        setDrag(null);
        if (!drop) return;
        if (drop.kind === "root") actions.open(panel);
        else if (drop.kind === "tabs") actions.moveTab(panel, drop.groupId, drop.index);
        else if (drop.zone === "center") actions.moveTab(panel, drop.groupId);
        else actions.splitWith(panel, drop.groupId, drop.zone);
      }
      function onKey(ev: KeyboardEvent) {
        if (ev.key !== "Escape") return;
        stop();
        setDrag(null);
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("keydown", onKey);
    },
    [actions, hitTest],
  );

  // A drag that ends on its own tab must not also count as a click that selects it.
  const consumeClick = useCallback(() => suppress.current, []);
  const getBounds = useCallback(() => rootRef.current?.getBoundingClientRect() ?? null, []);

  // Leave no stuck cursor class behind if the area is removed mid-drag.
  useEffect(
    () => () => {
      document.body.classList.remove("dock-dragging", "dock-resizing");
    },
    [],
  );

  const env: Env = { renderPanel, actions, startDrag, consumeClick, getBounds };
  const empty = !layout.root && layout.floating.length === 0;

  return (
    <div ref={rootRef} className="relative h-full min-h-0 w-full">
      {layout.root ? (
        <NodeView node={layout.root} env={env} />
      ) : (
        <div className="grid h-full place-items-center rounded-xl border border-dashed border-slate-700 p-6 text-center text-sm text-slate-400">
          {empty ? "No panels open. Use “Panels” or “Layout” in the header to bring some back." : "Drop a tab here to dock it."}
        </div>
      )}
      {layout.floating.map((win) => (
        <FloatingView key={win.id} win={win} env={env} />
      ))}
      {drag && drag.drop && <DropOverlay drop={drag.drop} />}
      {drag && (
        <div style={{ position: "fixed", left: drag.x + 12, top: drag.y + 12 }} className="pointer-events-none z-50 rounded-lg border border-teal-300/60 bg-slate-900 px-3 py-1.5 text-xs font-medium text-teal-200 shadow-xl">
          {PANEL_TITLES[drag.panel]}
        </div>
      )}
    </div>
  );
}
