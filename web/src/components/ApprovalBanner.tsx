import type { ClientCommand } from "../protocol";
import type { DashboardState } from "../state";

interface Props {
  state: DashboardState;
  send: (command: ClientCommand) => boolean;
}

// Shows what the agent wants to run or change (the real command or diff) and lets the controlling
// dashboard approve or reject. Nothing runs until someone answers.
export function ApprovalBanner({ state, send }: Props) {
  const approval = state.pendingApproval;
  if (!approval) return null;
  const mine = approval.via === "dashboard" && state.canControl;

  return (
    <section role="alertdialog" aria-label="Approval needed" className="rounded-2xl border border-amber-400/50 bg-amber-400/10 p-4 text-sm text-amber-100">
      <div className="flex items-start gap-3">
        <span className="mt-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-300" />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wider text-amber-300">
            {mine ? "Waiting for your approval" : approval.via === "dashboard" ? "Waiting for the controlling dashboard" : "Waiting for your answer in the terminal"}
          </div>
          <div className="mt-1 font-medium">{approval.message}</div>
          {approval.detail && (
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-slate-950/70 p-3 font-mono text-xs text-slate-200">
              {approval.detail}
            </pre>
          )}
        </div>
      </div>
      {mine && (
        <div className="mt-3 flex gap-3">
          <button
            type="button"
            onClick={() => send({ kind: "answer_approval", approved: true })}
            className="min-h-12 flex-[2] rounded-xl bg-teal-300 font-semibold text-slate-950 hover:bg-teal-200"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => send({ kind: "answer_approval", approved: false })}
            className="min-h-12 flex-1 rounded-xl border border-slate-600 bg-slate-800 font-semibold text-rose-300 hover:bg-slate-700"
          >
            Deny
          </button>
        </div>
      )}
    </section>
  );
}
