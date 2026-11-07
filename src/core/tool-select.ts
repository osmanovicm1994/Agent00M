// src/core/tool-select.ts
//
// Which tool schemas one run gets. Every request carries the schema of every tool (44 of them in a real run, about 7k tokens), and a
// local model reads that payload again for every call: on a 32k window it is a quarter of the prompt, and prompt processing was the
// biggest cost in the logs. Most tasks never use the browser, the deploy or the web tools, so those schemas are only sent when the
// agent's role or the task text calls for them.
//
// This only decides what is ADVERTISED. The executor still runs any known tool when it is called, so a wrong guess here costs a
// reminder, not a failure. The file tools, run_command, plan, ask_user and every unknown tool (MCP) are always kept.
// AGENT_TOOL_TRIM=0 switches trimming off (all tools, as before).

import type { ToolSchema } from "../llm/types";

const WEB_TOOLS = new Set(["web_search", "web_fetch", "web_research"]);
const BROWSER_TOOLS = new Set(["inspect_page", "check_styles", "design_search"]);
const DEPLOY_TOOLS = new Set(["deploy_template", "predeploy_check"]);
const PROCESS_TOOLS = new Set(["start_process", "process_logs", "stop_process"]);

/** The task asks for something that lives on the web: docs, a version, a lookup, a URL. */
const WEB_TASK_RE = /\b(web|online|internet|search|look ?up|latest|newest|current|docs?|documentation|changelog|release notes?|npm view|upgrade|compatib|deprecat)\b|https?:\/\//i;

/** The task is about something a person looks at in a browser. */
const UI_TASK_RE = /\b(ui|ux|page|pages|component|components|frontend|front-end|browser|screenshot|inspect|layout|css|tailwind|responsive|accessib\w*|a11y|landing|dashboard|form|modal|navbar|sidebar|theme|dark mode|route|e2e|playwright|visual)\b|\.(tsx|jsx|css|html)\b/i;

/** The task is about shipping: containers, servers, pipelines. */
const DEPLOY_TASK_RE = /\b(deploy\w*|docker\w*|compose|vps|nginx|caddy|reverse proxy|ci\/cd|ci pipeline|github actions|production|staging|kubernetes|k8s)\b/i;

const READ_ONLY_ROLES = new Set(["research", "kb-harvester", "logic"]);

export function toolTrimEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENT_TOOL_TRIM !== "0";
}

export function selectToolSchemas(all: ToolSchema[], agentId: string, task: string, env: NodeJS.ProcessEnv = process.env): ToolSchema[] {
  if (!toolTrimEnabled(env)) return all;

  const wantsWeb = agentId === "research" || WEB_TASK_RE.test(task);
  const wantsBrowser = agentId === "design" || agentId === "qa" ? true : !READ_ONLY_ROLES.has(agentId) && UI_TASK_RE.test(task);
  const wantsDeploy = agentId === "infra" || (!READ_ONLY_ROLES.has(agentId) && DEPLOY_TASK_RE.test(task));
  const wantsProcess = !READ_ONLY_ROLES.has(agentId);

  return all.filter((t) => {
    if (WEB_TOOLS.has(t.name)) return wantsWeb;
    if (BROWSER_TOOLS.has(t.name)) return wantsBrowser;
    if (DEPLOY_TOOLS.has(t.name)) return wantsDeploy;
    if (PROCESS_TOOLS.has(t.name)) return wantsProcess;
    return true;
  });
}
