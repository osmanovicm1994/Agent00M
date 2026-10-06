import { useEffect, useRef } from "react";
import { elapsed, summarizeArgs } from "../format";
import type { DashboardState, FeedItem } from "../state";

function AgentTag({ agent }: { agent: string }) {
  return (
    <span className="mr-2 shrink-0 rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-slate-400">
      {agent}
    </span>
  );
}

function FeedRow({ item, t0 }: { item: FeedItem; t0: number }) {
  return (
    <div className="flex gap-3">
      <span className="w-14 shrink-0 pt-0.5 text-right font-mono text-[11px] text-slate-600">
        +{elapsed(t0, item.ts)}
      </span>
      <div className="min-w-0 flex-1">
        <FeedBody item={item} />
      </div>
    </div>
  );
}

function FeedBody({ item }: { item: FeedItem }) {
  switch (item.kind) {
    case "note":
      return (
        <div className="text-slate-300">
          <AgentTag agent={item.agent} />
          {item.text}
        </div>
      );

    case "thinking":
      return (
        <div>
          <div className="mb-1 flex items-center text-[11px] text-slate-500">
            <AgentTag agent={item.agent} />
            💭 {item.label}
          </div>
          <div className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950/60 p-3 text-slate-400 italic">
            {item.text}
          </div>
        </div>
      );

    case "tool": {
      const border =
        item.status === "error"
          ? "border-rose-500/40"
          : item.status === "running"
            ? "border-sky-500/40"
            : "border-slate-800";
      const statusStyle =
        item.status === "error" ? "text-rose-400" : item.status === "running" ? "animate-pulse text-sky-300" : "text-emerald-400";
      const statusText = item.status === "error" ? "failed" : item.status === "running" ? "running" : "done";
      // Streamed command output wins; otherwise show the tool's result once it arrives.
      const body = item.output || (item.status === "running" ? "" : item.preview);

      return (
        <div className={`rounded-lg border bg-slate-950/60 p-3 font-mono text-xs ${border}`}>
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-amber-300">
              <AgentTag agent={item.agent} />⚙ {item.tool}
            </span>
            <span className={`shrink-0 ${statusStyle}`}>{statusText}</span>
          </div>
          <div className="mt-1 break-all text-slate-400">{summarizeArgs(item.args)}</div>
          {body && (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap border-t border-slate-800 pt-2 text-slate-300">
              {body}
            </pre>
          )}
        </div>
      );
    }

    case "artifact":
      return (
        <div className="text-emerald-300">
          <AgentTag agent={item.agent} />
          📄 {item.action} <span className="font-mono">{item.path}</span>{" "}
          <span className="text-emerald-300/60">({item.lines} lines)</span>
        </div>
      );

    case "final":
      return (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-emerald-300/80">Final answer</div>
          <div className="whitespace-pre-wrap text-slate-200">{item.text || "(no further message)"}</div>
        </div>
      );

    case "error":
      return (
        <div className="text-rose-400">
          <AgentTag agent={item.agent} />✖ {item.text}
        </div>
      );
  }
}

export function LiveFeed({ state }: { state: DashboardState }) {
  const scroller = useRef<HTMLDivElement>(null);
  // Follow new events only while the reader is at the bottom; scrolling up pauses auto-scroll.
  const stick = useRef(true);

  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.feed, state.llmWaiting]);

  const t0 = state.run?.startedAt ?? state.feed[0]?.ts ?? 0;

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/60">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5 text-xs text-slate-400">
        <span className="font-medium text-slate-300">Live feed</span>
        <span>{state.feed.length} events</span>
      </div>
      <div ref={scroller} onScroll={onScroll} className="h-[32rem] space-y-3 overflow-y-auto p-4 text-sm">
        {state.feed.length === 0 && <p className="text-slate-500">Nothing yet. The feed fills in as soon as an agent starts working.</p>}
        {state.feed.map((item) => (
          <FeedRow key={item.id} item={item} t0={t0} />
        ))}
        {state.llmWaiting && (
          <div className="flex gap-3">
            <span className="w-14 shrink-0" />
            <span className="animate-pulse text-xs text-sky-300">The model is generating…</span>
          </div>
        )}
      </div>
    </section>
  );
}
