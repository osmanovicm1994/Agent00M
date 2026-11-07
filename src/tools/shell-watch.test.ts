import { describe, expect, it } from "vitest";
import { ShellTool } from "./shell.tool";

describe("runAsync watchdog", () => {
  it("stops a command when the watchdog returns a reason, and reports it as failed (not as the user's Ctrl+C)", async () => {
    const shell = new ShellTool(process.cwd());
    let chunks = 0;
    const result = await shell.runAsync(
      `node -e "setInterval(() => console.log('tick'), 20)"`,
      20_000,
      undefined,
      undefined,
      30_000,
      () => (++chunks >= 3 ? "repeating itself" : null),
    );
    expect(result.aborted).toBe("repeating itself");
    expect(result.exitCode).not.toBe(0);
    expect(result.interrupted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain("tick");
  }, 15_000);

  it("leaves a normal command alone", async () => {
    const shell = new ShellTool(process.cwd());
    const result = await shell.runAsync(`node -e "console.log('done')"`, 20_000, undefined, undefined, 30_000, () => null);
    expect(result.aborted).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("done");
  }, 15_000);

  it("a watchdog that throws never breaks the command", async () => {
    const shell = new ShellTool(process.cwd());
    const result = await shell.runAsync(`node -e "console.log('ok')"`, 20_000, undefined, undefined, 30_000, () => {
      throw new Error("bug in the watchdog");
    });
    expect(result.exitCode).toBe(0);
    expect(result.aborted).toBeUndefined();
  }, 15_000);
});
