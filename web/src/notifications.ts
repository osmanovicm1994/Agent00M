import { useEffect, useRef } from "react";
import type { DashboardState } from "./state";

// Notifications of the dashboard (also the iPhone home-screen app).
//
// What this can do: while the page is alive (open, or just moved to the background) it shows a system
// notification when the agent needs an approval, finishes a run, or fails. The text never contains a command,
// a file name or any project content.
//
// What it cannot do: iOS freezes a home-screen app shortly after you leave it, which closes the socket, so
// nothing arrives while the app is fully closed. For that, set AGENT_NOTIFY_URL on the computer (ntfy, see
// src/notify.ts): the server then pushes approvals and failures to the phone by itself.
//
// iOS rules: notifications work only in an app added to the Home Screen (iOS 16.4 or newer), on a page served over
// HTTPS (the Tailscale address) or localhost, and the permission can only be asked from a tap.

const KEY = "agent-ui-notify";

export type NotifySupport = "ok" | "insecure" | "not-installed" | "unsupported";

export function notifySupport(): NotifySupport {
  if (typeof window === "undefined" || !("Notification" in window) || !("serviceWorker" in navigator)) {
    // iOS Safari tab (not installed): the Notification API is missing there.
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
    return ios ? "not-installed" : "unsupported";
  }
  if (!window.isSecureContext) return "insecure";
  return "ok";
}

export function notifyPermission(): NotificationPermission | "none" {
  return typeof window !== "undefined" && "Notification" in window ? Notification.permission : "none";
}

export function notifyEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === "on" && notifyPermission() === "granted";
  } catch {
    return false;
  }
}

function remember(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // storage can be blocked; the switch then lasts until reload
  }
}

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return undefined;
  }
}

// Asks for permission (call it from a tap) and switches the setting on. Returns a short message for the screen.
export async function enableNotifications(): Promise<{ ok: boolean; message: string }> {
  const support = notifySupport();
  if (support === "not-installed") {
    return { ok: false, message: "Add this page to your Home Screen first (Share, then Add to Home Screen), open it from there, then switch this on." };
  }
  if (support === "insecure") {
    return { ok: false, message: "Notifications need an HTTPS address (the Tailscale one) or localhost. This address is plain http." };
  }
  if (support === "unsupported") return { ok: false, message: "This browser does not support notifications." };

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    remember(false);
    return { ok: false, message: "Permission was not given. Change it in the phone's Settings, Notifications, for this app." };
  }
  const reg = await registration();
  if (!reg) return { ok: false, message: "Could not start the notification helper (service worker)." };
  remember(true);
  return { ok: true, message: "Notifications are on." };
}

export function disableNotifications(): void {
  remember(false);
}

async function show(title: string, body: string, tag: string): Promise<boolean> {
  try {
    const reg = (await navigator.serviceWorker.getRegistration()) ?? (await registration());
    if (!reg) return false;
    await reg.showNotification(title, { body, tag, icon: "/icon-192.png", badge: "/favicon-32.png" });
    return true;
  } catch {
    return false;
  }
}

// Sends a test notification right now (also from the foreground, so you can see that it works).
export function sendTestNotification(): Promise<boolean> {
  return show("Agent Mustafa", "Notifications work. You will be told when the agent needs you.", "agent-test");
}

// Watches the dashboard state and notifies when the page is in the background.
export function useNotifications(state: DashboardState): void {
  const approvalOpen = useRef<boolean>(false);
  const runStatus = useRef<Map<string, string>>(new Map());

  const pending = state.pendingApproval !== null;
  useEffect(() => {
    const was = approvalOpen.current;
    approvalOpen.current = pending;
    if (!pending || was) return;
    if (!notifyEnabled() || document.visibilityState !== "hidden") return;
    void show("Agent needs approval", "The agent is waiting for you to approve an action. Open the dashboard.", "agent-approval");
  }, [pending]);

  const runId = state.run?.runId;
  const status = state.run?.status;
  useEffect(() => {
    if (!runId || !status) return;
    const before = runStatus.current.get(runId);
    runStatus.current.set(runId, status);
    // Only a change seen live counts: a run replayed from history (first sighting as done) stays silent.
    if (before !== "running" || status === "running") return;
    if (!notifyEnabled() || document.visibilityState !== "hidden") return;
    if (status === "done") void show("Agent finished", "The run is complete. Open the dashboard to read the result.", "agent-run");
    else if (status === "failed") void show("Agent run failed", "The run stopped with an error. Open the dashboard.", "agent-run");
  }, [runId, status]);
}
