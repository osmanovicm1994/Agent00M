import { useState } from "react";
import type { ClientCommand } from "../protocol";
import type { DashboardState } from "../state";
import { SettingsPanel } from "./SettingsPanel";

interface Props {
  state: DashboardState;
  send: (command: ClientCommand) => boolean;
  dismissNotice: () => void;
  // Agent that receives the prompt ("only active"); null lets the orchestrator decide.
  pinned: string | null;
  // Files picked in the project tree. They are named at the top of the prompt.
  context: string[];
  onContextChange: (paths: string[]) => void;
  // Opens the file picker (a panel over the page).
  onAddFiles: () => void;
  // Kept for the old prop shape; the switches now live in SettingsPanel.
  onToggleTeam?: (on: boolean) => void;
}

// Send a task to the agent from the browser. Only rendered with a control token; the agent still
// asks for approval before writing files or running commands (answered in ApprovalBanner).
export function TaskComposer({ state, send, dismissNotice, pinned, context, onContextChange, onAddFiles }: Props) {
  const [task, setTask] = useState("");

  const disabled = !state.connected || state.busy;
  const canSubmit = !disabled && task.trim().length > 0;
  const target = state.roster.find((a) => a.id === pinned);

  const submit = () => {
    if (!canSubmit) return;
    const header = context.length > 0 ? `Focus on these files:\n${context.map((p) => `- ${p}`).join("\n")}\n\n` : "";
    const sent = send({ kind: "submit_task", task: header + task.trim(), agentId: pinned ?? undefined });
    if (sent) {
      setTask("");
      onContextChange([]);
    }
  };

  return (
    <section aria-label="Prompt" className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Prompt</h2>
        <span className="truncate font-mono text-xs text-slate-400">
          {state.busy ? "The agent is working…" : target ? `To ${target.name} · solo` : "To the orchestrator · auto routing"}
        </span>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Context</span>
        {context.length === 0 && <span className="text-xs text-slate-500">No files selected</span>}
        {context.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onContextChange(context.filter((x) => x !== p))}
            aria-label={`Remove ${p} from the prompt`}
            className="rounded-full border border-slate-700 bg-slate-800 px-3 py-1 font-mono text-xs hover:border-rose-400/60"
          >
            {p} ✕
          </button>
        ))}
        <button type="button" onClick={onAddFiles} className="min-h-11 rounded-lg border border-slate-700 px-3 text-xs font-medium text-teal-300 hover:bg-slate-800">
          + Add files
        </button>
      </div>

      <SettingsPanel settings={state.settings} send={send} disabled={!state.connected} />

      <textarea
        value={task}
        onChange={(e) => setTask(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
        disabled={disabled}
        rows={4}
        aria-label="Prompt"
        placeholder={target ? `Tell ${target.name} what to do…` : "Describe what the agent should do…"}
        className="w-full resize-y rounded-xl border border-slate-700 bg-slate-950 p-3 text-base text-slate-100 placeholder:text-slate-500 focus:border-teal-300 focus:outline-none disabled:opacity-50"
      />

      <div className="mt-3 flex items-center gap-3">
        <span className="hidden text-xs text-slate-500 sm:inline">⌘/Ctrl + Enter sends</span>
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="ml-auto min-h-12 rounded-xl bg-teal-300 px-6 text-sm font-semibold text-slate-950 transition hover:bg-teal-200 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
        >
          Send
        </button>
      </div>

      {state.notice && (
        <div
          role="status"
          className={`mt-3 flex items-start justify-between gap-3 rounded-xl px-3 py-2 text-xs ${
            state.notice.level === "error" ? "bg-rose-500/10 text-rose-300" : "bg-slate-800 text-slate-300"
          }`}
        >
          <span>{state.notice.text}</span>
          <button type="button" onClick={dismissNotice} className="shrink-0 opacity-70 hover:opacity-100" aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
    </section>
  );
}
