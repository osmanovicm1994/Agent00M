import { summarizeArgs } from "../format";
import type { DashboardState, FeedItem } from "../state";

type ToolItem = Extract<FeedItem, { kind: "tool" }>;
type ThinkingItem = Extract<FeedItem, { kind: "thinking" }>;

function lastOf<T extends FeedItem>(feed: FeedItem[], kind: T["kind"]): T | undefined {
  for (let i = feed.length - 1; i >= 0; i--) if (feed[i].kind === kind) return feed[i] as T;
  return undefined;
}

const STATUS_DOT: Record<string, string> = {
  running: "border-amber-300",
  ok: "border-teal-300 bg-teal-300",
  error: "border-rose-400 bg-rose-400",
};

interface Props {
  state: DashboardState;
  stop: () => void;
}

// What the agent wants to do and why. Built from what the agent actually emitted: the newest tool
// call is "wants to do", the newest reasoning text is "why". Nothing is invented.
export function ThinkingPanel({ state, stop }: Props) {
  const tool = lastOf<ToolItem>(state.feed, "tool");
  const thought = lastOf<ThinkingItem>(state.feed, "thinking");
  const steps = state.feed.filter((i): i is ToolItem => i.kind === "tool").slice(-8);
  const running = state.run?.status === "running";

  if (!state.run) {
    return (
      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-400">
        Nothing to show yet. When the agent starts, what it wants to do and why appears here.
      </section>
    );
  }

  const wants = tool ? `${tool.tool}: ${summarizeArgs(tool.args)}` : state.llmWaiting ? "Working out the first step…" : "Waiting for the first step.";
  const why = thought?.text?.trim();

  return (
    <section aria-label="Agent thinking" className="flex flex-col gap-3">
      <div className="rounded-2xl border border-slate-800 border-t-2 border-t-teal-300 bg-slate-900/60 p-4">
        <div className="text-[11px] font-medium uppercase tracking-wider text-teal-300">Wants to do</div>
        <p className="mt-1.5 break-words font-mono text-sm">{wants}</p>
        {running && tool?.status === "running" && (
          <button
            type="button"
            onClick={stop}
            disabled={!state.canControl}
            className="mt-3 min-h-11 rounded-xl border border-rose-400/40 bg-rose-950/40 px-4 text-xs font-semibold text-rose-300 hover:bg-rose-950/70 disabled:opacity-40"
          >
            Stop this command
          </button>
        )}
      </div>

      <div className="rounded-2xl border border-slate-800 border-t-2 border-t-amber-300 bg-slate-900/60 p-4">
        <div className="text-[11px] font-medium uppercase tracking-wider text-amber-300">
          Why{thought ? ` · ${thought.label}` : ""}
        </div>
        <p className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap text-sm text-slate-300">
          {why ? (why.length > 900 ? `${why.slice(0, 900)}…` : why) : "The model has not explained itself yet. Some models only call tools without writing reasoning."}
        </p>
      </div>

      {steps.length > 0 && (
        <ol className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
          <li className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Recent steps</li>
          {steps.map((s) => (
            <li key={s.id} className="flex items-start gap-3">
              <span className={`mt-1 h-4 w-4 shrink-0 rounded-full border-2 ${STATUS_DOT[s.status]}`} aria-hidden="true" />
              <span className="min-w-0 text-sm">
                <span className="font-mono text-slate-200">{s.tool}</span>
                <span className="block truncate font-mono text-xs text-slate-400">{summarizeArgs(s.args)}</span>
                <span className="sr-only">{s.status}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
