import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ClientCommand } from "../protocol";
import type { DashboardState } from "../state";
import { DEVICES, encodePath, findSourceLine, fitScale, isHtmlPath, nextRoutes, WEB_FILE, withRoute } from "../preview/helpers";

// A dashboard opened from another device cannot reach this computer's localhost.
const remote = !["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);

export type PreviewTarget = { kind: "file"; path: string } | { kind: "url"; url: string };

interface Props {
  state: DashboardState;
  send: (command: ClientCommand) => boolean;
  // The agent the dashboard has pinned ("only me"); feedback goes to it.
  pinned: string | null;
  target: PreviewTarget | null;
  onTargetChange: (target: PreviewTarget | null) => void;
}

interface Version {
  id: number;
  ts: number;
  html: string;
}

interface Picked {
  selector: string;
  tag: string;
  text: string;
  html: string;
}

const MAX_VERSIONS = 20;
let versionCounter = 0;

// Files the agent writes can be absolute or start with ./ : make them relative to the project folder.
function relativeTo(workspace: string | undefined, path: string): string {
  let p = path.replace(/^\.\//, "");
  if (workspace && p.startsWith(workspace + "/")) p = p.slice(workspace.length + 1);
  return p;
}

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

interface FrameProps {
  title: string;
  src?: string;
  srcDoc?: string;
  // Dev-server pages need their own origin (hot reload, storage); project files run fully sandboxed.
  trusted?: boolean;
  w: number | null;
  h: number | null;
  zoom: "fit" | number;
  box: { w: number; h: number };
  iframeRef?: RefObject<HTMLIFrameElement | null>;
  onLoad?: () => void;
}

// One preview screen: either fills the window (responsive) or a device size, scaled to fit.
function Frame({ title, src, srcDoc, trusted, w, h, zoom, box, iframeRef, onLoad }: FrameProps) {
  const sandbox = trusted ? "allow-scripts allow-same-origin allow-forms allow-popups allow-modals" : "allow-scripts allow-forms allow-popups allow-modals";
  if (w === null || h === null) {
    return <iframe ref={iframeRef} title={title} src={src} srcDoc={srcDoc} sandbox={sandbox} onLoad={onLoad} className="h-full min-h-[18rem] w-full rounded-lg border border-slate-700 bg-white" />;
  }
  const scale = zoom === "fit" ? fitScale(w, h, box.w - 16, box.h - 16) : zoom / 100;
  return (
    <div style={{ width: w * scale, height: h * scale }} className="shrink-0 overflow-hidden rounded-lg border border-slate-700 bg-white shadow-lg">
      <iframe
        ref={iframeRef}
        title={title}
        src={src}
        srcDoc={srcDoc}
        sandbox={sandbox}
        onLoad={onLoad}
        style={{ width: w, height: h, transform: `scale(${scale})`, transformOrigin: "top left" }}
        className="block border-0 bg-white"
      />
    </div>
  );
}

// Shows what the agent builds: an HTML file of the project (live, reloads on every change, can pick elements and
// send "change this" back to the agent) or a local dev server (view only).
export function PreviewPanel({ state, send, pinned, target, onTargetChange }: Props) {
  const key = state.previewKey;
  const workspace = state.run?.workspace;

  const [follow, setFollow] = useState(true);
  const [live, setLive] = useState(true);
  const [deviceId, setDeviceId] = useState("fit");
  const [landscape, setLandscape] = useState(false);
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [reloadKey, setReloadKey] = useState(0);
  const [versions, setVersions] = useState<Version[]>([]);
  const [compareId, setCompareId] = useState<number | null>(null);
  const [inspect, setInspect] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [instruction, setInstruction] = useState("");
  const [status, setStatus] = useState("");
  const [urlText, setUrlText] = useState(target?.kind === "url" ? target.url : "");
  const [box, setBox] = useState({ w: 600, h: 500 });

  const boxRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const filePath = target?.kind === "file" ? target.path : null;
  const src = useMemo(() => {
    if (target?.kind === "url") return target.url;
    if (filePath && key) return `/preview/${key}/${encodePath(filePath)}?v=${reloadKey}`;
    return undefined;
  }, [target, filePath, key, reloadKey]);

  // ---- which file is shown ----

  const htmlFiles = useMemo(
    () => (state.files?.entries ?? []).filter((e) => e.type === "file" && isHtmlPath(e.path)).map((e) => e.path),
    [state.files],
  );

  const latestHtml = useMemo(() => {
    for (let i = state.feed.length - 1; i >= 0; i--) {
      const item = state.feed[i];
      if (item.kind === "artifact" && isHtmlPath(item.path)) return relativeTo(workspace, item.path);
    }
    return null;
  }, [state.feed, workspace]);

  // When the agent writes a NEW html file, show it (unless you picked something yourself).
  const lastSeen = useRef<string | null>(latestHtml);
  useEffect(() => {
    if (!follow || !latestHtml) return;
    if (!target) {
      lastSeen.current = latestHtml;
      onTargetChange({ kind: "file", path: latestHtml });
      return;
    }
    if (latestHtml !== lastSeen.current) {
      lastSeen.current = latestHtml;
      onTargetChange({ kind: "file", path: latestHtml });
    }
  }, [follow, latestHtml, target, onTargetChange]);

  // When a dev server starts (the agent ran `npm run dev`), open it, unless you are looking at a project file.
  const newestDev = state.devUrls[0] ?? null;
  const lastDev = useRef<string | null>(null);
  useEffect(() => {
    if (!follow || remote || !newestDev || newestDev === lastDev.current) return;
    if (target && target.kind !== "url") return;
    lastDev.current = newestDev;
    if (target?.kind === "url" && target.url === newestDev) return;
    setUrlText(newestDev);
    onTargetChange({ kind: "url", url: newestDev });
  }, [follow, newestDev, target, onTargetChange]);

  // Pages of a Next.js project, for the "Go to page" menu.
  const routes = useMemo(() => nextRoutes(state.files?.entries ?? []), [state.files]);

  // ---- live reload ----

  const reloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) return;
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = undefined;
      setReloadKey((k) => k + 1);
    }, 250);
  }, []);
  useEffect(
    () => () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
    },
    [],
  );

  const lastReload = useRef(Date.now());
  useEffect(() => {
    if (!live || !filePath || state.changeTick === 0) return;
    const fresh = Object.entries(state.changed).some(([p, t]) => t > lastReload.current && WEB_FILE.test(p));
    if (!fresh) return;
    lastReload.current = Date.now();
    scheduleReload();
  }, [live, filePath, state.changeTick, state.changed, scheduleReload]);

  // Fallback when the file watcher is not available: every file the agent writes also reloads.
  const artifactCount = useMemo(() => state.feed.filter((i) => i.kind === "artifact").length, [state.feed]);
  const firstCount = useRef(artifactCount);
  useEffect(() => {
    if (artifactCount !== firstCount.current) {
      firstCount.current = artifactCount;
      if (live && filePath) scheduleReload();
    }
  }, [artifactCount, live, filePath, scheduleReload]);

  // ---- version history (the HTML of each change) ----

  useEffect(() => {
    setVersions([]);
    setCompareId(null);
    setPicked(null);
  }, [filePath]);

  useEffect(() => {
    if (!filePath || !key || !isHtmlPath(filePath)) return;
    let cancelled = false;
    fetch(`/preview/${key}/${encodePath(filePath)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.text() : null))
      .then((html) => {
        if (cancelled || html === null) return;
        setVersions((prev) => {
          if (prev.length > 0 && prev[prev.length - 1].html === html) return prev;
          versionCounter += 1;
          return [...prev, { id: versionCounter, ts: Date.now(), html }].slice(-MAX_VERSIONS);
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [filePath, key, reloadKey]);

  const compareVersion = compareId === null ? undefined : versions.find((v) => v.id === compareId);
  const comparing = compareVersion !== undefined && target?.kind === "file";

  // ---- measuring the available space ----

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // ---- element picker ----

  const postInspect = useCallback((on: boolean) => {
    iframeRef.current?.contentWindow?.postMessage({ source: "agent-preview", type: "inspect", on }, "*");
  }, []);

  useEffect(() => {
    postInspect(inspect);
  }, [inspect, postInspect]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as { source?: string; type?: string; selector?: string; tag?: string; text?: string; html?: string } | null;
      if (!d || d.source !== "agent-inspector") return;
      if (d.type === "ready") {
        postInspect(inspect);
      } else if (d.type === "pick" && typeof d.selector === "string") {
        setPicked({ selector: d.selector, tag: String(d.tag ?? ""), text: String(d.text ?? ""), html: String(d.html ?? "") });
        setInstruction("");
        setStatus("");
        setInspect(false);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [inspect, postInspect]);

  const canSend = state.canControl && state.acceptsTasks && !state.busy;

  const sendFeedback = async () => {
    const note = instruction.trim();
    if (!picked || !filePath || !key || !note) return;
    let line: number | null = null;
    try {
      const r = await fetch(`/preview/${key}/${encodePath(filePath)}?raw=1`, { cache: "no-store" });
      if (r.ok) line = findSourceLine(await r.text(), picked.html);
    } catch {
      line = null;
    }
    const task = [
      `Change the design in ${filePath}${line ? ` (near line ${line})` : ""}.`,
      `Element picked in the preview: ${picked.selector} (<${picked.tag}>${picked.text ? `, text "${picked.text}"` : ""}).`,
      `Its current HTML: ${picked.html}`,
      "",
      `What to change: ${note}`,
      "",
      "Change only what is needed and keep the rest of the page as it is.",
    ].join("\n");
    const ok = send({ kind: "submit_task", task, agentId: pinned ?? undefined });
    setStatus(ok ? "Sent to the agent. The preview reloads when the file changes." : "Not sent: the connection is closed.");
    if (ok) {
      setPicked(null);
      setInstruction("");
    }
  };

  // ---- dev-server address ----

  const goUrl = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    try {
      const u = new URL(text.includes("://") ? text : `http://${text}`);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http and https addresses.");
      if (u.origin === window.location.origin) throw new Error("That is this dashboard itself.");
      setStatus("");
      setUrlText(u.toString());
      onTargetChange({ kind: "url", url: u.toString() });
    } catch (err) {
      setStatus((err as Error).message || "That is not a valid address.");
    }
  };

  // ---- layout ----

  const dev = DEVICES.find((d) => d.id === deviceId) ?? DEVICES[0];
  const w = dev.w === null || dev.h === null ? null : landscape ? dev.h : dev.w;
  const h = dev.w === null || dev.h === null ? null : landscape ? dev.w : dev.h;
  const paneBox = comparing ? { w: Math.floor(box.w / 2) - 12, h: box.h } : box;

  const btn = "min-h-9 rounded-lg border border-slate-700 px-3 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-40";
  const on = "bg-slate-800 text-teal-300";
  const sel = "min-h-9 rounded-lg border border-slate-700 bg-slate-950 px-2 text-xs";

  return (
    <section aria-label="Design preview" className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Source" className="flex overflow-hidden rounded-lg border border-slate-700">
          <button
            type="button"
            aria-pressed={target?.kind !== "url"}
            onClick={() => onTargetChange(filePath ? target : htmlFiles[0] ? { kind: "file", path: htmlFiles[0] } : null)}
            className={`min-h-9 px-3 text-xs font-medium ${target?.kind !== "url" ? on : "text-slate-300 hover:bg-slate-800/60"}`}
          >
            Project file
          </button>
          <button
            type="button"
            aria-pressed={target?.kind === "url"}
            onClick={() => goUrl(urlText || state.devUrls[0] || "")}
            className={`min-h-9 px-3 text-xs font-medium ${target?.kind === "url" ? on : "text-slate-300 hover:bg-slate-800/60"}`}
          >
            Dev server
          </button>
        </div>

        {target?.kind !== "url" && (
          <select
            aria-label="HTML file to preview"
            value={filePath ?? ""}
            onChange={(e) => {
              setFollow(false);
              onTargetChange(e.target.value ? { kind: "file", path: e.target.value } : null);
            }}
            className={`${sel} max-w-[16rem]`}
          >
            <option value="">{htmlFiles.length === 0 ? "No HTML file yet" : "Choose a file…"}</option>
            {filePath && !htmlFiles.includes(filePath) && <option value={filePath}>{filePath}</option>}
            {htmlFiles.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        )}

        <button type="button" onClick={() => setReloadKey((k) => k + 1)} disabled={!src} className={btn}>
          Reload
        </button>
        <button type="button" aria-pressed={live} onClick={() => setLive(!live)} title="Reload when a project file changes" className={`${btn} ${live ? on : ""}`} disabled={target?.kind === "url"}>
          Live
        </button>
        <button type="button" aria-pressed={follow} onClick={() => setFollow(!follow)} title="Switch to each new HTML file the agent writes, and open a dev server when it starts" className={`${btn} ${follow ? on : ""}`}>
          Follow agent
        </button>
        {src && (
          <a href={src} target="_blank" rel="noopener noreferrer" className={`${btn} inline-flex items-center`}>
            Open in tab
          </a>
        )}
      </div>

      {target?.kind === "url" && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            goUrl(urlText);
          }}
        >
          <input
            value={urlText}
            onChange={(e) => setUrlText(e.target.value)}
            placeholder="http://localhost:3000"
            aria-label="Dev server address"
            className="min-h-9 min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 font-mono text-xs"
          />
          <button type="submit" className={btn}>
            Open
          </button>
          {state.devUrls.map((u) => (
            <button key={u} type="button" onClick={() => goUrl(u)} className="rounded-full border border-slate-700 px-2.5 py-1 font-mono text-[11px] text-sky-300 hover:bg-slate-800">
              {u}
            </button>
          ))}
          {routes.length > 0 && target?.kind === "url" && (
            <select
              aria-label="Go to page"
              value=""
              onChange={(e) => {
                const next = e.target.value ? withRoute(target.url, e.target.value) : null;
                if (next) goUrl(next);
              }}
              className={sel}
            >
              <option value="">Go to page…</option>
              {routes.map((r) => (
                <option key={r.route} value={r.route} disabled={r.dynamic}>
                  {r.route}
                  {r.dynamic ? " (needs an id)" : ""}
                </option>
              ))}
            </select>
          )}
          {remote && <p className="w-full text-[11px] text-amber-300/80">You are not on this computer: localhost addresses point at this device, so use a project file here.</p>}
        </form>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Device" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className={sel}>
          {DEVICES.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => setLandscape(!landscape)} disabled={w === null} aria-pressed={landscape} className={`${btn} ${landscape ? on : ""}`}>
          Rotate
        </button>
        <select aria-label="Zoom" value={String(zoom)} onChange={(e) => setZoom(e.target.value === "fit" ? "fit" : Number(e.target.value))} disabled={w === null} className={sel}>
          <option value="fit">Fit</option>
          <option value="50">50%</option>
          <option value="75">75%</option>
          <option value="100">100%</option>
        </select>

        {target?.kind === "file" && (
          <>
            <select
              aria-label="Compare with an earlier version"
              value={compareId ?? ""}
              onChange={(e) => setCompareId(e.target.value ? Number(e.target.value) : null)}
              disabled={versions.length < 2}
              className={sel}
            >
              <option value="">{versions.length < 2 ? "No earlier version yet" : "Compare with…"}</option>
              {versions
                .slice(0, -1)
                .reverse()
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    Version from {time(v.ts)}
                  </option>
                ))}
            </select>
            <button
              type="button"
              aria-pressed={inspect}
              onClick={() => setInspect(!inspect)}
              disabled={comparing}
              title="Click an element in the preview to tell the agent what to change"
              className={`${btn} ${inspect ? on : ""}`}
            >
              {inspect ? "Click an element…" : "Pick element"}
            </button>
          </>
        )}
      </div>

      <div ref={boxRef} className="min-h-0 flex-1 overflow-auto rounded-xl border border-slate-800 bg-slate-950/40 p-2">
        {!src ? (
          <div className="grid h-full place-items-center p-4 text-center text-sm text-slate-400">
            {target?.kind === "url"
              ? "Enter the address of a dev server, for example http://localhost:3000."
              : !state.canControl
                ? "The preview needs the control token (open the full URL printed in the terminal)."
                : !key
                  ? "Connecting…"
                  : htmlFiles.length === 0
                    ? routes.length > 0
                      ? "This looks like a Next.js project: its pages are .tsx files that need a running server. Ask the agent to start `npm run dev`; the preview opens it by itself, or choose Dev server above."
                      : "No HTML file in the project yet. Ask the design agent for an HTML mock-up, or open a dev server."
                    : "Choose an HTML file above."}
          </div>
        ) : comparing && compareVersion ? (
          <div className="flex min-h-full items-start justify-center gap-3">
            <div className="flex min-w-0 flex-col items-center gap-1">
              <span className="text-[11px] text-slate-400">Earlier · {time(compareVersion.ts)}</span>
              <Frame title="Earlier version" srcDoc={compareVersion.html} w={w} h={h} zoom={zoom} box={paneBox} />
            </div>
            <div className="flex min-w-0 flex-col items-center gap-1">
              <span className="text-[11px] text-slate-400">Current</span>
              <Frame title="Current version" src={src} w={w} h={h} zoom={zoom} box={paneBox} />
            </div>
          </div>
        ) : (
          <div className={`flex min-h-full justify-center ${w === null ? "h-full" : "items-start"}`}>
            <Frame title="Design preview" src={src} trusted={target?.kind === "url"} w={w} h={h} zoom={zoom} box={box} iframeRef={iframeRef} onLoad={() => postInspect(inspect)} />
          </div>
        )}
      </div>

      {picked && (
        <div className="rounded-xl border border-teal-300/30 bg-teal-300/5 p-3 text-xs">
          <div className="font-mono text-teal-200">
            {picked.selector} <span className="text-slate-400">&lt;{picked.tag}&gt;</span>
          </div>
          {picked.text && <div className="mt-1 truncate text-slate-300">“{picked.text}”</div>}
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void sendFeedback();
              }}
              placeholder="What should change here?"
              aria-label="What should change"
              className="min-h-10 min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
            />
            <button type="button" onClick={() => void sendFeedback()} disabled={!canSend || !instruction.trim()} className="min-h-10 rounded-lg bg-teal-300 px-4 text-xs font-semibold text-slate-950 hover:bg-teal-200 disabled:opacity-40">
              Send to agent
            </button>
            <button type="button" onClick={() => setPicked(null)} className={btn}>
              Cancel
            </button>
          </div>
          {!canSend && <p className="mt-1 text-amber-300/80">{state.busy ? "The agent is busy with another task." : "The agent cannot take tasks from the dashboard right now."}</p>}
        </div>
      )}

      {status && (
        <p role="status" className="text-xs text-slate-300">
          {status}
        </p>
      )}
      {target?.kind === "url" && <p className="text-[11px] text-slate-500">Dev server mode is view only: you can click through the app, but Pick element works only for project HTML files.</p>}
      {target?.kind === "file" && !picked && <p className="text-[11px] text-slate-500">Runs in a sandbox: scripts work, but the page cannot reach the dashboard. Earlier versions keep the HTML of each change; linked CSS and scripts always show the current files.</p>}
    </section>
  );
}
