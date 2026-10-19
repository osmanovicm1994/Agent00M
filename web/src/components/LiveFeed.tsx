import { useEffect, useMemo, useRef, useState } from "react";
import { elapsed, exitCodeOf, parseArgs } from "../format";
import type { DashboardState, FeedItem } from "../state";

type Filter = "all" | "tools" | "thinking" | "files" | "alerts";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "tools", label: "Commands & tools" },
  { id: "thinking", label: "Thinking" },
  { id: "files", label: "Files" },
  { id: "alerts", label: "Warnings" },
];

function matches(item: FeedItem, f: Filter): boolean {
  switch (f) {
    case "all":
      return true;
    case "tools":
      return item.kind === "tool";
    case "thinking":
      return item.kind === "thinking" || item.kind === "stats";
    case "files":
      return item.kind === "artifact";
    case "alerts":
      return item.kind === "error" || (item.kind === "log" && item.level === "warn");
  }
}

function AgentTag({ agent }: { agent: string }) {
  return (
    <span className="mr-2 shrink-0 rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-slate-300">
      {agent}
    </span>
  );
}

// Long text is cut to a few lines with a "Show more" toggle, so one huge prompt does not push everything away.
function Clamp({ text, lines = 3, className = "" }: { text: string; lines?: number; className?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 280 || text.split("\n").length > lines;
  return (
    <div className={className}>
      <div
        className="whitespace-pre-wrap break-words"
        style={open || !long ? undefined : { display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden" }}
      >
        {text}
      </div>
      {long && (
        <button type="button" onClick={() => setOpen(!open)} className="mt-1 text-xs text-teal-300 hover:underline">
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function ToolCard({ item }: { item: Extract<FeedItem, { kind: "tool" }> }) {
  const [openOut, setOpenOut] = useState(false);
  const a = parseArgs(item.args);
  const code = item.status === "running" ? undefined : exitCodeOf(item.preview);
  const border = item.status === "error" ? "border-rose-400/40" : item.status === "running" ? "border-teal-300/40" : "border-slate-800";
  const chip =
    item.status === "running"
      ? { text: "running", cls: "animate-pulse text-teal-300" }
      : item.status === "error"
        ? { text: code !== undefined ? `failed · exit ${code}` : "failed", cls: "text-rose-300" }
        : { text: code !== undefined ? `done · exit ${code}` : "done", cls: "text-emerald-300" };
  // Streamed command output wins; otherwise the tool's result once it arrives (a command's result is JSON, so only
  // the streamed text is useful there).
  const isCommand = item.tool === "run_command" || item.tool === "start_process";
  const body = item.output || (item.status === "running" || isCommand ? "" : item.preview);
  const longBody = body.length > 1200 || body.split("\n").length > 14;

  return (
    <div className={`rounded-xl border bg-slate-950/60 p-3 font-mono text-xs ${border}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-amber-300">
          <AgentTag agent={item.agent} />
          Agent wants to run: <span className="font-semibold">{item.tool}</span>
        </span>
        <span className={`shrink-0 ${chip.cls}`}>{chip.text}</span>
      </div>
      {a.command && (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-slate-900 p-2 text-slate-100">
          <span className="select-none text-teal-300">$ </span>
          {a.command}
        </pre>
      )}
      {a.path && !a.command && <div className="mt-2 break-all text-slate-200">{a.path}</div>}
      {a.reason && <div className="mt-2 font-sans text-[13px] text-slate-300">Reason: {a.reason}</div>}
      {a.rest && <div className="mt-1 break-all text-slate-500">{a.rest}</div>}
      {!a.command && !a.path && !a.rest && !a.reason && <div className="mt-2 break-all text-slate-400">{item.args}</div>}
      {body && (
        <>
          <pre
            className={`mt-2 overflow-auto whitespace-pre-wrap break-words border-t border-slate-800 pt-2 text-slate-300 ${openOut ? "max-h-[32rem]" : "max-h-48"}`}
          >
            {body}
          </pre>
          {longBody && (
            <button type="button" onClick={() => setOpenOut(!openOut)} className="mt-1 text-teal-300 hover:underline">
              {openOut ? "Collapse output" : "Expand output"}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function FeedBody({ item }: { item: FeedItem }) {
  switch (item.kind) {
    case "note":
      return (
        <div className="text-sm text-slate-300">
          <AgentTag agent={item.agent} />
          <Clamp text={item.text} className="inline-block align-top" />
        </div>
      );

    case "log":
      if (item.level === "step") {
        return (
          <div className="mt-2 rounded-lg border-l-2 border-teal-300 bg-teal-300/5 px-3 py-2 text-sm font-semibold text-teal-100">{item.text}</div>
        );
      }
      if (item.level === "plan") {
        return (
          <div className="rounded-xl border border-sky-300/30 bg-sky-300/5 p-3">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-sky-300">Team plan</div>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-sans text-sm text-slate-200">{item.text}</pre>
          </div>
        );
      }
      return (
        <div className={`text-sm ${item.level === "warn" ? "text-amber-300" : "text-slate-400"}`}>
          {item.level === "warn" ? "⚠ " : ""}
          {item.text}
        </div>
      );

    case "stats":
      return <div className="font-mono text-[11px] text-slate-500">⏱ {item.text}</div>;

    case "thinking":
      return (
        <div>
          <div className="mb-1 flex items-center text-[11px] text-slate-400">
            <AgentTag agent={item.agent} />💭 {item.label}
          </div>
          <div className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-slate-950/60 p-3 text-sm text-slate-300 italic">
            {item.text}
          </div>
        </div>
      );

    case "tool":
      return <ToolCard item={item} />;

    case "artifact":
      return (
        <div className="text-sm text-emerald-300">
          <AgentTag agent={item.agent} />
          📄 {item.action} <span className="font-mono">{item.path}</span> <span className="text-emerald-300/60">({item.lines} lines)</span>
        </div>
      );

    case "final":
      return (
        <div className="rounded-xl border border-emerald-400/30 bg-emerald-400/5 p-3">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-emerald-300">Agent</div>
          <div className="whitespace-pre-wrap break-words text-sm text-slate-100">{item.text || "(no further message)"}</div>
        </div>
      );

    case "error":
      return (
        <div className="text-sm text-rose-300">
          <AgentTag agent={item.agent} />✖ {item.text}
        </div>
      );
  }
}

// `fill`: the feed takes all the height its parent gives it and scrolls inside (the Live screen), instead of a fixed box.
export function LiveFeed({ state, fill = false }: { state: DashboardState; fill?: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<Filter>("all");
  // Follow new events only while the reader is at the bottom; scrolling up pauses auto-scroll.
  const stick = useRef(true);

  const items = useMemo(() => state.feed.filter((i) => matches(i, filter)), [state.feed, filter]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, state.llmWaiting]);

  const t0 = state.run?.startedAt ?? state.feed[0]?.ts ?? 0;

  return (
    <section aria-label="Live feed" className={`flex min-h-0 flex-col rounded-2xl border border-slate-800 bg-slate-900/60 ${fill ? "h-full" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-2.5 text-xs text-slate-400">
        <div role="group" aria-label="Filter" className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`min-h-9 rounded-lg px-3 font-medium ${filter === f.id ? "bg-slate-800 text-teal-300" : "text-slate-300 hover:bg-slate-800/60"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span>
          {items.length}
          {filter !== "all" ? ` of ${state.feed.length}` : ""} events
        </span>
      </div>
      <div ref={scroller} onScroll={onScroll} className={`min-h-0 space-y-3 overflow-y-auto p-4 ${fill ? "flex-1" : "h-[32rem]"}`}>
        {items.length === 0 && <p className="text-sm text-slate-400">Nothing yet. The feed fills in as soon as an agent starts working.</p>}
        {items.map((item) => (
          <div key={item.id} className="flex gap-3">
            <span className="w-14 shrink-0 pt-0.5 text-right font-mono text-[11px] text-slate-500">+{elapsed(t0, item.ts)}</span>
            <div className="min-w-0 flex-1">
              <FeedBody item={item} />
            </div>
          </div>
        ))}
        {state.llmWaiting && (
          <div className="flex gap-3">
            <span className="w-14 shrink-0" />
            <span className="animate-pulse text-xs text-teal-300">The model is generating…</span>
          </div>
        )}
      </div>
    </section>
  );
}
