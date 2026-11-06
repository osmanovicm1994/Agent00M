import { describe, expect, it } from "vitest";
import { selectToolSchemas } from "./tool-select";
import type { ToolSchema } from "../llm/types";

const names = [
  "read_file", "read_multiple_files", "list_directory", "get_directory_tree", "write_file", "append_file", "edit_file",
  "find_files", "grep", "run_command", "update_plan", "ask_user",
  "web_search", "web_fetch", "web_research",
  "inspect_page", "check_styles", "design_search",
  "deploy_template", "predeploy_check",
  "start_process", "process_logs", "stop_process",
  "sequentialthinking",
];
const ALL: ToolSchema[] = names.map((name) => ({ name, description: name, parameters: { type: "object", properties: {} } }));
const pick = (agent: string, task: string, env: NodeJS.ProcessEnv = {}) => selectToolSchemas(ALL, agent, task, env).map((t) => t.name);
const CORE = ["read_file", "read_multiple_files", "list_directory", "get_directory_tree", "write_file", "append_file", "edit_file", "find_files", "grep", "run_command", "update_plan", "ask_user", "sequentialthinking"];

describe("selectToolSchemas", () => {
  it("a plain backend task keeps the core tools and the process tools, and drops web, browser and deploy", () => {
    const t = pick("api", "Add a POST /api/bookings endpoint that stores a booking row");
    for (const n of CORE) expect(t, n).toContain(n);
    expect(t).toContain("start_process");
    for (const n of ["web_search", "inspect_page", "check_styles", "design_search", "deploy_template", "predeploy_check"]) expect(t, n).not.toContain(n);
    expect(t.length).toBeLessThan(ALL.length - 5);
  });

  it("a UI task brings the browser tools, a deploy task the deploy tools, a lookup task the web tools", () => {
    expect(pick("dev", "Build the booking page component with Tailwind")).toContain("inspect_page");
    expect(pick("dev", "Add a Dockerfile and a docker compose file")).toContain("predeploy_check");
    expect(pick("dev", "Look up the latest Prisma release notes")).toContain("web_search");
  });

  it("roles decide their own tools", () => {
    expect(pick("design", "Fix the spacing")).toContain("check_styles");
    expect(pick("qa", "Write the checks")).toContain("inspect_page");
    expect(pick("infra", "Create the skeleton")).toContain("deploy_template");
    expect(pick("research", "Find out how X works")).toContain("web_search");
  });

  it("read-only roles get no process, browser or deploy tools", () => {
    const t = pick("logic", "Plan the page layout and the docker deploy");
    for (const n of ["start_process", "inspect_page", "deploy_template"]) expect(t, n).not.toContain(n);
    for (const n of ["read_file", "grep", "ask_user"]) expect(t, n).toContain(n);
  });

  it("keeps every unknown (MCP) tool and switches off with AGENT_TOOL_TRIM=0", () => {
    expect(pick("api", "Add an endpoint")).toContain("sequentialthinking");
    expect(pick("api", "Add an endpoint", { AGENT_TOOL_TRIM: "0" })).toHaveLength(ALL.length);
  });
});
