// src/core/interrupt.ts
//
// Ctrl+C while a command runs: stop that command (and only that), not the whole CLI.
//
// Why a stdin watcher is needed: in the chat, readline keeps the terminal in raw mode and the
// executor pauses readline while it works, so a Ctrl+C keypress would be swallowed by a paused
// stream and nothing would happen. While a command runs we resume stdin and look for the Ctrl+C byte.
// Outside a TTY (CI, piped input) the normal SIGINT handler in cli.ts takes over.

import { interruptRunningCommands } from "../tools/shell.tool";

/** Starts watching for Ctrl+C. Returns a function that restores the previous terminal state. */
export function watchForInterrupt(onInterrupt: () => void = () => void interruptRunningCommands()): () => void {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return () => undefined;

  const wasRaw = stdin.isRaw;
  const wasPaused = stdin.isPaused();
  const onData = (chunk: Buffer | string) => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (bytes.includes(0x03)) onInterrupt(); // Ctrl+C
  };

  try {
    stdin.setRawMode(true);
    stdin.on("data", onData);
    stdin.resume();
  } catch {
    return () => undefined;
  }

  return () => {
    stdin.off("data", onData);
    try {
      stdin.setRawMode(wasRaw);
    } catch {
      // terminal already gone
    }
    if (wasPaused) stdin.pause();
  };
}

export function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}
