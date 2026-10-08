// Starts the dashboard web app (Vite) and opens it in the browser, so `npm run chat:ui` is one
// command. Best effort: every failure only prints a hint, because the terminal agent works without it.
//   AGENT_UI_WEB=0   do not start the Vite dev server (you run `npm run web` yourself)
//   AGENT_UI_OPEN=0  do not open the browser (the URL is still printed)

import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import pc from "picocolors";

const WEB_DIR = path.resolve(__dirname, "..", "web");
const WEB_PORT = Number(process.env.AGENT_UI_WEB_PORT) || 5173;

let webProcess: ChildProcess | undefined;

function flagOff(name: string): boolean {
  return ["0", "off", "false", "no"].includes((process.env[name] ?? "").trim().toLowerCase());
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => console.log(pc.yellow(`⚠ Could not open the browser automatically. Open: ${url}`)));
    child.unref();
  } catch {
    console.log(pc.yellow(`⚠ Could not open the browser automatically. Open: ${url}`));
  }
}

// Fire and forget: do not await this, the chat questions should appear immediately.
export async function launchDashboard(url: string): Promise<void> {
  try {
    if (!flagOff("AGENT_UI_WEB") && !(await portOpen(WEB_PORT))) {
      if (!fs.existsSync(path.join(WEB_DIR, "node_modules"))) {
        console.log(pc.yellow("⚠ Dashboard dependencies are missing. Run `npm run web:install` once, then restart."));
        return;
      }
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      // Own process group (non-Windows) so stopDashboard() also ends the vite child of npm.
      webProcess = spawn(npm, ["--prefix", WEB_DIR, "run", "dev"], { stdio: "ignore", detached: process.platform !== "win32" });
      webProcess.on("error", () => console.log(pc.yellow("⚠ Could not start the dashboard web app. Run `npm run web` in another terminal.")));
      webProcess.on("exit", () => {
        webProcess = undefined;
      });
    }

    if (!(await waitForPort(WEB_PORT, 30_000))) {
      console.log(pc.yellow(`⚠ The dashboard web app did not start on port ${WEB_PORT}. Run \`npm run web\` in another terminal.`));
      return;
    }
    if (flagOff("AGENT_UI_OPEN")) return;
    openInBrowser(url);
  } catch (err: any) {
    console.log(pc.yellow(`⚠ Dashboard launch failed: ${err?.message ?? err}`));
  }
}

export function stopDashboard(): void {
  const child = webProcess;
  webProcess = undefined;
  if (!child || child.killed) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill();
  } catch {
    // already gone
  }
}

process.on("exit", stopDashboard);
