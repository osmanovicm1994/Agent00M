// Optional phone notification when the agent waits for an approval (for example a risky command) or
// a run ends. Off unless AGENT_NOTIFY_URL is set. It POSTs plain text to that URL, which is what
// ntfy (https://ntfy.sh/<your-secret-topic>, or your own ntfy server) expects: install the ntfy app on
// the phone and subscribe to the same topic.
//
// Privacy: the text never contains the command, a file path or any project content. It only says
// that the agent needs you, and which agent. A public ntfy.sh topic is readable by anyone who knows
// its name, so use a long random topic name or run ntfy yourself on the tailnet.

import { bus } from "./core/events";

const NOTIFY_URL = (process.env.AGENT_NOTIFY_URL ?? "").trim();
const NOTIFY_DONE = !["0", "off", "false", "no"].includes((process.env.AGENT_NOTIFY_DONE ?? "").trim().toLowerCase());

async function post(title: string, body: string, priority: "default" | "high"): Promise<void> {
  try {
    await fetch(NOTIFY_URL, {
      method: "POST",
      headers: { Title: title, Priority: priority, Tags: priority === "high" ? "warning" : "white_check_mark" },
      body,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // a missing network must never disturb the agent
  }
}

// Subscribes to the event bus. Returns a function that stops it, or undefined when notifications are off.
export function startNotifier(): (() => void) | undefined {
  if (!NOTIFY_URL) return undefined;
  return bus.subscribe((event) => {
    if (event.type === "approval_requested" && event.payload.via === "dashboard") {
      void post("Agent needs approval", `${event.agent} is waiting for you to approve an action. Open the dashboard.`, "high");
    } else if (NOTIFY_DONE && event.type === "run_failed") {
      void post("Agent run failed", `${event.agent} stopped with an error. Open the dashboard.`, "default");
    }
  });
}
