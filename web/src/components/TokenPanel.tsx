import { useState } from "react";
import { startOfDay, tokens } from "../format";
import type { UsageEntry } from "../state";

type Range = "session" | "today" | "week";

const RANGES: { id: Range; label: string }[] = [
  { id: "session", label: "Session" },
  { id: "today", label: "Today" },
  { id: "week", label: "7 days" },
];

interface Props {
  // Everything stored on this device (all sessions).
  usage: UsageEntry[];
  // Calls seen since the dashboard connected (this server session).
  sessionKeys: Set<string>;
  roster: { id: string; name: string }[];
}

// Token usage of the agent's model. These are the numbers the model server reports (or a
// character-based estimate, marked "est."). They are NOT a Claude subscription meter.
export function TokenPanel({ usage, sessionKeys, roster }: Props) {
  const [range, setRange] = useState<Range>("today");
  const now = Date.now();
  const from = range === "today" ? startOfDay(now) : range === "week" ? startOfDay(now) - 6 * 86_400_000 : 0;
  const rows = usage.filter((u) => (range === "session" ? sessionKeys.has(u.key) : u.ts >= from));

  const prompt = rows.reduce((a, u) => a + u.prompt, 0);
  const completion = rows.reduce((a, u) => a + u.completion, 0);
  const total = prompt + completion;
  const estimated = rows.some((u) => u.estimated);

  const byAgent = new Map<string, number>();
  for (const u of rows) byAgent.set(u.agent, (byAgent.get(u.agent) ?? 0) + u.prompt + u.completion);
  const names = new Map(roster.map((a) => [a.id, a.name]));
  const agents = [...byAgent.entries()].sort((a, b) => b[1] - a[1]);
  const max = agents[0]?.[1] ?? 1;

  return (
    <section aria-label="Token usage" className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Token usage</h2>
        <div role="group" aria-label="Range" className="flex gap-1 rounded-xl border border-slate-800 bg-slate-950/60 p-1">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={range === r.id}
              onClick={() => setRange(r.id)}
              className={`min-h-9 rounded-lg px-3 text-xs font-medium ${range === r.id ? "bg-slate-800 text-teal-300" : "text-slate-300"}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 font-mono text-3xl font-medium">
        {tokens(total)}
        {estimated && <span className="ml-2 text-xs font-normal text-amber-300">est.</span>}
      </div>
      <div className="mt-1 text-xs text-slate-400">
        {rows.length} model call{rows.length === 1 ? "" : "s"} · in {tokens(prompt)} · out {tokens(completion)}
      </div>

      <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-slate-800" aria-hidden="true">
        <div className="bg-teal-300" style={{ width: `${total ? (prompt / total) * 100 : 0}%` }} />
        <div className="bg-sky-300" style={{ width: `${total ? (completion / total) * 100 : 0}%` }} />
      </div>
      <div className="mt-1 flex gap-4 text-[11px] text-slate-400">
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-teal-300" />Input</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-sky-300" />Output</span>
      </div>

      {agents.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2">
          {agents.map(([id, n]) => (
            <li key={id} className="text-xs">
              <div className="flex justify-between">
                <span>{names.get(id) ?? id}</span>
                <span className="font-mono text-slate-400">{tokens(n)}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-800">
                <div className="h-full bg-teal-300/80" style={{ width: `${(n / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 text-xs text-slate-500">
        Counts the agent's model calls, kept on this device. Cached answers cost nothing and are not counted.
      </p>
    </section>
  );
}
