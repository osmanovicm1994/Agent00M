import type { ClientCommand, PlannerMode, SettingKey, SettingsState } from "../protocol";

interface Props {
  settings: SettingsState | null;
  send: (command: ClientCommand) => boolean;
  // Greys everything out (no control token, or not connected).
  disabled?: boolean;
}

interface Row {
  key: Exclude<SettingKey, "planner">;
  title: string;
  hint: (s: SettingsState) => string;
  // Why the switch cannot be turned on right now (shown instead of the hint), or undefined.
  blocked?: (s: SettingsState) => string | undefined;
}

// The same switches the terminal has: /team, /parallel, /auto-write, /auto-run, /auto-debug, /research, /plan.
const ROWS: Row[] = [
  {
    key: "team",
    title: "Team mode",
    hint: () => "Project Manager plans, engineers build, Safety Reviewer checks. For bigger tasks.",
  },
  {
    key: "parallel",
    title: "Parallel team",
    hint: (s) =>
      s.autoWrite && s.autoRun
        ? "Independent engineer tasks run at the same time (only in team mode)."
        : "Independent engineer tasks run at the same time. Needs auto-write and auto-run.",
  },
  {
    key: "autoWrite",
    title: "Auto-write",
    hint: () => "Files are written and commands run without asking (risky ones still ask). Switches auto-run with it.",
  },
  {
    key: "autoRun",
    title: "Auto-run",
    hint: () => "Shell commands run without asking. Risky ones (rm, sudo, git push...) still ask.",
    blocked: (s) => (s.autoRunLocked ? "Disabled by AGENT_AUTO_RUN=0 in your env file." : undefined),
  },
  {
    key: "autoDebug",
    title: "Auto-debug",
    hint: (s) =>
      s.autoWrite && s.autoRun
        ? "A failed command starts the Debug Agent right away, then the task resumes."
        : "A failed command starts the Debug Agent. Only active while auto-write and auto-run are on.",
  },
  {
    key: "research",
    title: "Research stage",
    hint: () => "Gemini (Google Search) researches each task first. Sends your question and a file-name overview to Google.",
    blocked: (s) => (s.researchAvailable ? undefined : "Needs GEMINI_API_KEY in your .env."),
  },
];

const PLANNER_MODES: { id: PlannerMode; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "always", label: "Always" },
  { id: "off", label: "Off" },
];

function Switch({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-7 w-12 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-40 ${on ? "bg-teal-300" : "bg-slate-700"}`}
    >
      <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${on ? "left-6" : "left-1"}`} />
    </button>
  );
}

// Every terminal switch as a toggle. The agent keeps the real state: the terminal commands and these
// switches change the same values, so they never disagree.
export function SettingsPanel({ settings, send, disabled }: Props) {
  if (!settings) {
    return <div className="mb-3 rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2 text-xs text-slate-500">Loading settings…</div>;
  }

  const set = (key: SettingKey, value: boolean | PlannerMode) => send({ kind: "set_setting", key, value });

  return (
    <div className="mb-3 divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-950/50">
      {ROWS.map((row) => {
        const on = settings[row.key];
        const block = row.blocked?.(settings);
        return (
          <div key={row.key} className="flex items-center gap-3 px-3 py-2">
            <Switch on={on} label={row.title} disabled={disabled || (Boolean(block) && !on)} onChange={(v) => set(row.key, v)} />
            <div className="min-w-0 text-xs">
              <div className="font-medium text-slate-200">
                {row.title} {on ? "on" : "off"}
              </div>
              <div className={block ? "text-amber-300/80" : "text-slate-400"}>{block ?? row.hint(settings)}</div>
            </div>
          </div>
        );
      })}

      <div className="flex items-center gap-3 px-3 py-2">
        <div className="flex shrink-0 overflow-hidden rounded-lg border border-slate-700" role="radiogroup" aria-label="Planner mode">
          {PLANNER_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={settings.planner === m.id}
              disabled={disabled || !settings.researchAvailable}
              onClick={() => set("planner", m.id)}
              className={`min-h-9 px-3 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                settings.planner === m.id ? "bg-teal-300 text-slate-950" : "text-slate-300 hover:bg-slate-800"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="min-w-0 text-xs">
          <div className="font-medium text-slate-200">Planner</div>
          <div className="text-slate-400">Auto = only when the research says a plan is needed. Works with the research stage.</div>
        </div>
      </div>
    </div>
  );
}
