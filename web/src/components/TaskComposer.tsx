import { useState } from "react";
import type { ClientCommand } from "../protocol";
import type { DashboardState } from "../state";

interface Props {
  state: DashboardState;
  send: (command: ClientCommand) => boolean;
  dismissNotice: () => void;
}

// Send a task to the agent from the browser. Only rendered with a control token; the agent still
// asks for approval before writing files or running commands (answered in ApprovalBanner).
export function TaskComposer({ state, send, dismissNotice }: Props) {
  const [task, setTask] = useState("");
  const [agentId, setAgentId] = useState("");

  const disabled = !state.connected || state.busy;
  const canSubmit = !disabled && task.trim().length > 0;

  const submit = () => {
    if (!canSubmit) return;
    const sent = send({ kind: "submit_task", task: task.trim(), agentId: agentId || undefined });
    if (sent) setTask("");
  };

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium text-slate-200">New task</h2>
        <span className="text-xs text-slate-500">
          {state.busy ? "The agent is working…" : "Runs in the project folder chosen in the terminal"}
        </span>
      </div>

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
        rows={3}
        placeholder="Describe what the agent should do…"
        className="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none disabled:opacity-50"
      />

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-slate-400">
          Agent
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            disabled={disabled}
            className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 disabled:opacity-50"
          >
            <option value="">Auto (orchestrator decides)</option>
            {state.roster.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="ml-auto rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
        >
          Send <span className="ml-1 text-xs opacity-70">⌘/Ctrl + Enter</span>
        </button>
      </div>

      {state.notice && (
        <div
          className={`mt-3 flex items-start justify-between gap-3 rounded-lg px-3 py-2 text-xs ${
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
