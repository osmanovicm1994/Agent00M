import { useRef, useState } from "react";
import type { ClientCommand } from "../protocol";
import type { DashboardState } from "../state";
import { hasPanel, PANEL_IDS, PANEL_TITLES, PRESETS, validateLayout, type Layout, type PanelId, type PresetId } from "../layout/model";
import { DEFAULT_IGNORE_TEXT, parseIgnoreText } from "../prefs";
import { SettingsPanel } from "./SettingsPanel";
import { SettingsScreen } from "./SettingsScreen";

interface Props {
  state: DashboardState;
  send: (command: ClientCommand) => boolean;
  ignoreText: string;
  onIgnoreChange: (text: string) => void;
  layout: Layout;
  onOpenPanel: (panel: PanelId) => void;
  onClosePanel: (panel: PanelId) => void;
  onPreset: (id: PresetId) => void;
  onReplaceLayout: (layout: Layout) => void;
  onOpenGuide: () => void;
  // The panel layout only exists on a wide screen.
  showLayout: boolean;
}

const MAX_IMPORT_BYTES = 200_000;

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

// All settings in one place: the agent's switches, the panel layout, the project tree, and this device.
export function SettingsHub({ state, send, ignoreText, onIgnoreChange, layout, onOpenPanel, onClosePanel, onPreset, onReplaceLayout, onOpenGuide, showLayout }: Props) {
  const [draft, setDraft] = useState(ignoreText);
  const [message, setMessage] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const btn = "min-h-10 rounded-lg border border-slate-700 px-3 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-40";

  const exportLayout = () => {
    const blob = new Blob([JSON.stringify(layout, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "agent-layout.json";
    a.click();
    URL.revokeObjectURL(url);
    setMessage("Layout saved as agent-layout.json.");
  };

  const importLayout = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setMessage("That file is too big to be a layout.");
      return;
    }
    try {
      const parsed = validateLayout(JSON.parse(await file.text()));
      if (!parsed) throw new Error("not a layout");
      onReplaceLayout(parsed);
      setMessage("Layout loaded.");
    } catch {
      setMessage("That file is not a layout saved from this dashboard.");
    }
  };

  const applyIgnore = () => {
    const clean = parseIgnoreText(draft).join("|") || DEFAULT_IGNORE_TEXT;
    setDraft(clean);
    onIgnoreChange(clean);
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <Section title="Agent" hint="The same switches as the terminal commands. The agent keeps the real state.">
        <SettingsPanel settings={state.settings} send={send} disabled={!state.canControl || !state.connected} />
      </Section>

      {showLayout && (
        <Section title="Layout" hint="Drag a tab onto another panel to join it, onto an edge to split, drag the dividers to resize. The layout is kept in this browser.">
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button key={p.id} type="button" title={p.hint} onClick={() => onPreset(p.id)} className={btn}>
                {p.label}
              </button>
            ))}
            <button type="button" onClick={exportLayout} className={btn}>
              Export layout
            </button>
            <button type="button" onClick={() => fileRef.current?.click()} className={btn}>
              Import layout
            </button>
            <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => {
              void importLayout(e.target.files?.[0]);
              e.target.value = "";
            }} />
          </div>
          <ul className="mt-3 grid gap-1 sm:grid-cols-2">
            {PANEL_IDS.map((id) => {
              const open = hasPanel(layout, id);
              return (
                <li key={id} className="flex items-center justify-between rounded-lg bg-slate-950/50 px-3 py-1.5 text-xs">
                  <span className={open ? "text-slate-100" : "text-slate-500"}>{PANEL_TITLES[id]}</span>
                  <button type="button" onClick={() => (open ? onClosePanel(id) : onOpenPanel(id))} className="min-h-8 rounded px-2 text-teal-300 hover:bg-slate-800">
                    {open ? "Close" : "Open"}
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      <Section title="Project tree" hint="Names to leave out, like tree -I. Separate with | or commas. * and ? work inside a name. Secret .env files are always hidden.">
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            applyIgnore();
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Names the project tree leaves out"
            spellCheck={false}
            className="min-h-10 min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 font-mono text-xs"
          />
          <button type="submit" disabled={draft === ignoreText} className={btn}>
            Apply
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(DEFAULT_IGNORE_TEXT);
              onIgnoreChange(DEFAULT_IGNORE_TEXT);
            }}
            className={btn}
          >
            Reset
          </button>
        </form>
        <p className="mt-2 text-[11px] text-slate-500">
          The default also hides <span className="font-mono">.agent_cache</span>: tens of thousands of cache files that would fill the whole list.
        </p>
      </Section>

      {message && (
        <p role="status" className="text-xs text-slate-300">
          {message}
        </p>
      )}

      <SettingsScreen onOpenGuide={onOpenGuide} />
    </div>
  );
}
