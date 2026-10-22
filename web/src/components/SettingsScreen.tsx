import { useState } from "react";
import {
  disableNotifications,
  enableNotifications,
  notifyEnabled,
  notifyPermission,
  notifySupport,
  sendTestNotification,
} from "../notifications";

interface Props {
  onOpenGuide: () => void;
}

const SUPPORT_TEXT: Record<string, string> = {
  "not-installed": "On iPhone, notifications only work in the app added to the Home Screen: tap Share, then Add to Home Screen, and open Agent from there.",
  insecure: "Notifications need an HTTPS address (the Tailscale one, npm run chat:ui:remote) or localhost. This page is on plain http.",
  unsupported: "This browser does not support notifications.",
};

// Settings of this device (not of the agent): notifications, and the way to the prompting guide.
export function SettingsScreen({ onOpenGuide }: Props) {
  const support = notifySupport();
  const [on, setOn] = useState(() => notifyEnabled());
  const [message, setMessage] = useState<string>("");
  const permission = notifyPermission();

  const toggle = async () => {
    if (on) {
      disableNotifications();
      setOn(false);
      setMessage("Notifications are off.");
      return;
    }
    const result = await enableNotifications();
    setOn(result.ok);
    setMessage(result.message);
    if (result.ok) await sendTestNotification();
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <section aria-label="Notifications" className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="text-sm font-semibold">Notifications</h2>
        <p className="mt-1 text-xs text-slate-400">
          Get a notification when the agent needs your approval, finishes, or fails. The text never contains a command, a file name or project
          content.
        </p>

        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label="Notifications on this device"
            disabled={support !== "ok" && !on}
            onClick={toggle}
            className={`relative h-7 w-12 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-40 ${on ? "bg-teal-300" : "bg-slate-700"}`}
          >
            <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${on ? "left-6" : "left-1"}`} />
          </button>
          <div className="min-w-0 text-xs">
            <div className="font-medium text-slate-200">Notifications on this device {on ? "on" : "off"}</div>
            <div className={support === "ok" ? "text-slate-400" : "text-amber-300/80"}>
              {support === "ok" ? "Shown when the app is in the background." : SUPPORT_TEXT[support]}
            </div>
          </div>
        </div>

        {permission === "denied" && (
          <p className="mt-2 text-xs text-amber-300/80">
            The permission was denied. Change it in the phone's Settings, Notifications, Agent, then switch this on again.
          </p>
        )}
        {message && (
          <p role="status" className="mt-2 text-xs text-slate-300">
            {message}
          </p>
        )}

        {on && (
          <button
            type="button"
            onClick={() => void sendTestNotification()}
            className="mt-3 min-h-11 rounded-lg border border-slate-700 px-3 text-xs font-medium text-teal-300 hover:bg-slate-800"
          >
            Send a test notification
          </button>
        )}

        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-xs text-slate-400">
          <div className="mb-1 font-medium text-slate-200">Good to know</div>
          iOS freezes a home-screen app a short time after you leave it. Notifications arrive while the app is open or was just left, not when it
          is fully closed. For alerts that always arrive, set <code className="rounded bg-slate-800 px-1 font-mono text-teal-200">AGENT_NOTIFY_URL</code>{" "}
          in the agent's .env (ntfy: install the ntfy app on the phone, subscribe to your private topic). The computer then pushes approvals and
          failures by itself, even with this app closed.
        </div>
      </section>

      <section aria-label="Guide" className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="text-sm font-semibold">Prompting guide</h2>
        <p className="mt-1 text-xs text-slate-400">How to write prompts so the agent builds what you want: structure, slicing, UI briefs, debugging, templates.</p>
        <button
          type="button"
          onClick={onOpenGuide}
          className="mt-3 min-h-12 rounded-xl bg-teal-300 px-5 text-sm font-semibold text-slate-950 hover:bg-teal-200"
        >
          Open the guide
        </button>
      </section>
    </div>
  );
}
