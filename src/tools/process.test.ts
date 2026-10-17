import { afterEach, describe, expect, it } from "vitest";
import * as net from "net";
import { ProcessManager, isPortOpen, processToolSchemas } from "./process.tool";

const cwd = process.cwd();
const managers: ProcessManager[] = [];
function manager(): ProcessManager {
  const m = new ProcessManager(cwd);
  managers.push(m);
  return m;
}
afterEach(() => {
  managers.splice(0).forEach((m) => m.stopAll());
});

const SERVER = `node -e "console.log('server ready on 4000'); setInterval(()=>{},1000)"`;

describe("ProcessManager", () => {
  it("starts a process, waits for the ready pattern, reads logs and stops it", async () => {
    const m = manager();
    const started = JSON.parse(await m.start({ name: "web", command: SERVER, readyPattern: "ready on" }));
    expect(started.status).toBe("ready");
    expect(started.output).toContain("server ready");

    const logs = JSON.parse(m.logs("web"));
    expect(logs.running).toBe(true);

    const stopped = JSON.parse(await m.stop("web"));
    expect(stopped.stopped).toBe(true);
    expect(m.logs("web")).toContain("TOOL ERROR");
  }, 15_000);

  it("reports a process that exits right away with its exit code and output", async () => {
    const m = manager();
    const r = JSON.parse(await m.start({ name: "bad", command: `node -e "console.error('boom'); process.exit(3)"`, readyPattern: "never" }));
    expect(r.status).toBe("exited");
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain("boom");
  }, 15_000);

  it("refuses a second process with the same name and a port that is already taken", async () => {
    const m = manager();
    await m.start({ name: "web", command: SERVER, readyPattern: "ready on" });
    expect(await m.start({ name: "web", command: SERVER })).toContain("already running");

    const server = net.createServer().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as net.AddressInfo).port;
    expect(await isPortOpen(port)).toBe(true);
    expect(await m.start({ name: "other", command: SERVER, port })).toContain("already in use");
    server.close();
  }, 15_000);

  it("rejects an empty command and exposes three tool schemas", async () => {
    expect(await manager().start({ command: "  " })).toContain("TOOL ERROR");
    expect(processToolSchemas.map((s) => s.name)).toEqual(["start_process", "process_logs", "stop_process"]);
  });
});
