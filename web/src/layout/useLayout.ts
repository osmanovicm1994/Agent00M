import { useCallback, useEffect, useMemo, useState } from "react";
import * as M from "./model";
import type { LayoutActions } from "./Workspace";

const KEY = "agent-ui-layout-v1";

function load(): M.Layout {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const layout = M.validateLayout(JSON.parse(raw));
      if (layout) return layout;
    }
  } catch {
    // storage blocked or the saved text is damaged: start from the default
  }
  return M.presetLayout("coding");
}

// The layout of the dashboard: kept in this browser (localStorage), changed through LayoutActions.
export function useLayout() {
  const [layout, setLayout] = useState<M.Layout>(load);

  // Saved shortly after the last change (dragging a divider changes it many times per second).
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(KEY, JSON.stringify(layout));
      } catch {
        // the layout then lasts until reload
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [layout]);

  const actions: LayoutActions = useMemo(
    () => ({
      setActive: (groupId, panel) => setLayout((l) => M.setActive(l, groupId, panel)),
      setSizes: (splitId, sizes) => setLayout((l) => M.setSizes(l, splitId, sizes)),
      moveTab: (panel, groupId, index) => setLayout((l) => M.addTab(l, groupId, panel, index)),
      splitWith: (panel, groupId, side) => setLayout((l) => M.splitGroup(l, groupId, panel, side)),
      float: (panel, rect) => setLayout((l) => M.floatPanel(l, panel, rect)),
      dock: (panel) => setLayout((l) => M.dockPanel(l, panel)),
      close: (panel) => setLayout((l) => M.closePanel(l, panel)),
      open: (panel) => setLayout((l) => M.openPanel(l, panel)),
      raise: (id) => setLayout((l) => M.raiseFloating(l, id)),
      moveFloating: (id, x, y) => setLayout((l) => M.moveFloating(l, id, x, y)),
      resizeFloating: (id, w, h) => setLayout((l) => M.resizeFloating(l, id, w, h)),
    }),
    [],
  );

  const applyPreset = useCallback((id: M.PresetId) => setLayout(M.presetLayout(id)), []);
  const replace = useCallback((next: M.Layout) => setLayout(next), []);

  return { layout, actions, applyPreset, replace };
}
