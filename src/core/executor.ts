import * as path from "path";
import type { ChatMessage, LLMProvider, LLMResponse, ToolCall, ToolSchema } from "../llm/types";
import type { AgentDefinition } from "../agents/definitions";
import { detectStackKnowledge, loadKnowledge } from "../agents/helpers";
import { FsTools, fsToolSchemas } from "../tools/fs.tool";
import { ShellTool, shellToolSchema } from "../tools/shell.tool";
import { SearchTool, searchToolSchemas } from "../tools/search.tool";
import type { McpManager } from "../mcp/client";
import { renderDiff } from "./diff";
import prompts from "prompts";
import pc from "picocolors";
import { builtinModules } from "module";

const BUILTIN_TOOL_SCHEMAS: ToolSchema[] = [...fsToolSchemas, shellToolSchema, ...searchToolSchemas];

const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS) || 50;
// Rough character budget for the running conversation. Older bulky tool output
// is elided once this is exceeded so a local model's context never overflows.
const CONTEXT_CHAR_BUDGET = Number(process.env.AGENT_CONTEXT_CHARS) || 60_000;
const TOOL_OUTPUT_LIMIT = 30_000;
const MAX_THINKING_CALLS = 8;
const MAX_NUDGES = 6;
const STACK_KNOWLEDGE_CHARS = 6000;

// Tools that only read state. Several of these may be executed in one turn.
const READ_ONLY_TOOLS = new Set([
  "read_file",
  "read_multiple_files",
  "list_directory",
  "get_directory_tree",
  "find_files",
  "grep",
]);

// ---------------------------------------------------------------------------
// Action parsing
// ---------------------------------------------------------------------------
// Some local models won't emit proper OpenAI-style tool_calls even when a
// `tools` array is passed, so we also accept fenced blocks in the reply.
//
// write_file / append_file use a RAW block (no JSON escaping) because asking a
// model to JSON-encode a whole source file is where generation breaks. The
// closing fence is located by fence-aware rules, not "first ``` wins", so files
// that themselves contain code fences (Markdown!) are no longer cut short.

interface FileBlock {
  tool: "write_file" | "append_file";
  path: string;
  content: string;
  // false = the reply ended before the closing fence (output was cut off).
  complete: boolean;
}

const FILE_BLOCK_OPEN_RE = /^(`{3,})[ \t]*(write_file|append_file)[ \t]+(\S+)[ \t]*\r?\n/m;

function parseFileBlock(reply: string): FileBlock | null {
  const open = FILE_BLOCK_OPEN_RE.exec(reply);
  if (!open) return null;

  const fenceLen = open[1].length;
  const tool = open[2] as FileBlock["tool"];
  const filePath = open[3].replace(/^["'`]+|["'`]+$/g, "");
  const body = reply.slice(open.index + open[0].length);
  const lines = body.split("\n");

  let closeIdx = -1;
  if (fenceLen >= 4) {
    // Longer fence: the closer is the last line made only of >= fenceLen backticks.
    const closer = new RegExp("^`{" + fenceLen + ",}\\s*$");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (closer.test(lines[i])) {
        closeIdx = i;
        break;
      }
    }
  } else {
    // 3-backtick fence: inner code fences come in open/close pairs, so a properly
    // closed block contains an ODD number of fence lines (pairs + the closer).
    const fenceLines: number[] = [];
    lines.forEach((l, i) => {
      if (/^\s*`{3,}/.test(l)) fenceLines.push(i);
    });
    if (fenceLines.length % 2 === 1) closeIdx = fenceLines[fenceLines.length - 1];
  }

  const complete = closeIdx !== -1;
  const bodyLines = complete ? lines.slice(0, closeIdx) : lines;
  return { tool, path: filePath, content: bodyLines.join("\n").replace(/\r\n/g, "\n"), complete };
}

// A write attempt that exists but can't be read at all (e.g. the path is
// missing from the opening fence line).
function looksLikeMalformedFileBlock(reply: string): boolean {
  return /`{3,}[ \t]*(write_file|append_file)/.test(reply) && !FILE_BLOCK_OPEN_RE.test(reply);
}

function parseFallbackActions(content: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const clean = content.trim();

  // Raw JSON without markdown fences.
  if (clean.startsWith("{") && clean.endsWith("}")) {
    try {
      const parsed = JSON.parse(clean);
      const toolName = parsed.tool || parsed.name;
      if (typeof toolName === "string") {
        return [
          {
            id: `fallback-${Date.now()}-raw`,
            name: toolName,
            arguments: JSON.stringify(parsed.arguments ?? {}),
          },
        ];
      }
    } catch {
      // not valid raw JSON, fall through
    }
  }

  // Fenced ```action / ```json blocks.
  const blocks = [...content.matchAll(/```(?:action|json)?\s*([\s\S]*?)```/g)];
  blocks.forEach((match, idx) => {
    try {
      const parsed = JSON.parse(match[1].trim());
      const toolName = parsed.tool || parsed.name;
      if (typeof toolName !== "string") return;
      calls.push({
        id: `fallback-${Date.now()}-${idx}`,
        name: toolName,
        arguments: JSON.stringify(parsed.arguments ?? {}),
      });
    } catch {
      // malformed JSON in this block
    }
  });

  return calls;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// File names mentioned in the model's prose. Used to catch the model claiming
// it changed a named file that was never actually written this session.
const FILE_MENTION_RE = /\b[\w.\/-]+\.(?:ts|tsx|js|jsx|json)\b/g;

function extractMentionedFiles(content: string): string[] {
  return [...new Set([...content.matchAll(FILE_MENTION_RE)].map((m) => m[0]))];
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

// "." for a top-level file, otherwise the parent directory path.
function dirnameOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "." : p.slice(0, idx);
}

// Bare (non-relative) import/require specifiers, used to sanity-check a new
// file's imports against what the project actually depends on.
const IMPORT_RE = /(?:from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|^import\s+['"]([^'"]+)['"])/gm;
const CODE_FILE_RE = /\.(?:[cm]?[jt]sx?)$/i;

function extractImportedPackages(content: string): string[] {
  const specifiers = new Set<string>();
  for (const match of content.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec) specifiers.add(spec);
  }
  const packages = new Set<string>();
  for (const spec of specifiers) {
    if (spec.startsWith(".") || spec.startsWith("/")) continue;
    const clean = spec.startsWith("node:") ? spec.slice(5) : spec;
    if (clean.startsWith("@")) packages.add(clean.split("/").slice(0, 2).join("/"));
    else packages.add(clean.split("/")[0]);
  }
  return [...packages];
}

// Comment-style placeholders that mean "I skipped part of the file". Writing
// one of these to disk silently deletes real code.
const PLACEHOLDER_RE =
  /(?:\/\/|#|\/\*|<!--)\s*(?:\.{3}|…)?\s*(?:rest of (?:the )?(?:file|code|implementation)|existing (?:code|content|imports)|remaining (?:code|content)|(?:code|content) (?:here|unchanged)|previous code|same as before)/i;

// Names that legitimately exist in many folders; never flagged as "duplicate".
const DUPLICATE_NAME_EXEMPT = /^(index\.\w+|readme\.md|claude\.md|skill\.md|package\.json|tsconfig\.json|__init__\.py)$/i;

// Secret-bearing env files. The agent may read .env.example but never real
// secrets: file contents are sent to the model (possibly a cloud endpoint) and
// stored in the response cache.
function isSecretPath(p: string): boolean {
  const name = basename(p).toLowerCase();
  if (!name.startsWith(".env")) return false;
  return !/\.(example|sample|template)$/.test(name);
}

function ensureTrailingNewline(s: string): string {
  return s.length > 0 && !s.endsWith("\n") ? s + "\n" : s;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function clip(s: string): string {
  return s.length > TOOL_OUTPUT_LIMIT
    ? s.slice(0, TOOL_OUTPUT_LIMIT) + `\n[OUTPUT TRUNCATED: ${s.length - TOOL_OUTPUT_LIMIT} more chars not shown]`
    : s;
}

async function confirm(message: string): Promise<boolean> {
  const response = await prompts({ type: "confirm", name: "ok", message, initial: false });
  return Boolean(response.ok);
}

export interface ExecutorResult {
  finalMessage: string;
  stepsTaken: number;
  filesWritten: string[];
  commandsRun: string[];
}

// Per-run bookkeeping used to catch a model's bad behavior (guessing paths,
// guessing frameworks, lying about completion, looping on no-ops).
interface SessionState {
  // Files the agent has read IN FULL (partial/truncated reads don't count).
  filesRead: Set<string>;
  filesWritten: string[];
  commandsRun: string[];
  // Directories the agent has actually inspected. Creating a NEW file in a
  // directory that was never inspected is blocked.
  dirsListed: Set<string>;
  warnedDuplicatePaths: Set<string>;
  warnedUnknownDeps: Set<string>;
  warnedShrink: Set<string>;
  // Lazily computed union of every package.json's dependencies.
  declaredDependencies: Set<string> | null;
  thinkingCalls: number;
}

function newSessionState(): SessionState {
  return {
    filesRead: new Set(),
    filesWritten: [],
    commandsRun: [],
    dirsListed: new Set(["."]),
    warnedDuplicatePaths: new Set(),
    warnedUnknownDeps: new Set(),
    warnedShrink: new Set(),
    declaredDependencies: null,
    thinkingCalls: 0,
  };
}

export class Executor {
  private fs: FsTools;
  private shell: ShellTool;
  private search: SearchTool;
  private toolSchemas: ToolSchema[];

  constructor(
    private readonly llm: LLMProvider,
    private readonly workspaceRoot: string,
    private readonly mcp?: McpManager,
  ) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.fs = new FsTools(this.workspaceRoot);
    this.shell = new ShellTool(this.workspaceRoot);
    this.search = new SearchTool(this.workspaceRoot);
    this.toolSchemas = [...BUILTIN_TOOL_SCHEMAS, ...(mcp?.schemas() ?? [])];
  }

  // Normalizes a model-supplied path: forward slashes, no leading "./",
  // absolute paths inside the workspace turned into relative ones.
  private np(p: unknown): string {
    if (typeof p !== "string") return "";
    let n = p.trim().replace(/\\/g, "/");
    if (path.isAbsolute(n)) {
      const rel = path.relative(this.workspaceRoot, n).replace(/\\/g, "/");
      if (!rel.startsWith("..")) n = rel || ".";
    }
    n = path.posix.normalize(n || ".");
    if (n.startsWith("./")) n = n.slice(2);
    return n === "" ? "." : n;
  }

  // Union of every package.json's dependencies in the project (best effort).
  private computeDeclaredDependencies(): Set<string> {
    const result = new Set<string>();
    const packageJsonPaths = this.search.findFiles("package.json", 50).filter((p) => basename(p) === "package.json");
    for (const p of packageJsonPaths) {
      try {
        const parsed = JSON.parse(this.fs.readFile(p));
        for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
          const deps = parsed[section];
          if (deps && typeof deps === "object") for (const name of Object.keys(deps)) result.add(name);
        }
      } catch {
        // unreadable or malformed package.json
      }
    }
    return result;
  }

  private hasThinkingTool(): boolean {
    return this.toolSchemas.some((t) => /think/i.test(t.name));
  }

  private buildSystemPrompt(agent: AgentDefinition, stackPaths: string[]): string {
    const stack = loadKnowledge(stackPaths, STACK_KNOWLEDGE_CHARS);
    const toolNames = this.toolSchemas.map((t) => t.name).join(", ");

    return `${agent.systemPrompt}${stack}

You have access to these tools: ${toolNames}.
If your runtime does not support native tool calls, use these fenced-block formats instead.

Tools with simple arguments (read_file, read_multiple_files, get_directory_tree, find_files, grep, run_command${this.hasThinkingTool() ? ", MCP tools" : ""}):
\`\`\`action
{"name": "get_directory_tree", "arguments": {"path": ".", "maxDepth": 4}}
\`\`\`

write_file and append_file take RAW file content. Never JSON-encode it. Put the path on the opening fence line:
\`\`\`write_file path/to/file.ts
<complete raw file content, verbatim>
\`\`\`
\`\`\`append_file path/to/file.ts
<the next chunk, continuing exactly where the file currently ends>
\`\`\`
If the file content itself contains triple backticks (e.g. a Markdown file), open and close the block with FOUR backticks.

CRITICAL TOOL RULES:
1. Map the project with ONE get_directory_tree call. Do not crawl with list_directory.
2. Read-only tools (read_file, read_multiple_files, get_directory_tree, find_files, grep) may be batched: several in one turn is fine. write_file, append_file and run_command: exactly ONE per turn, then wait for the result.
3. Long files: write_file with the first ~150 lines, then append_file with chunks of ~150 lines until done. Never abbreviate with placeholders like "// ... rest of file".
4. read_file returns the whole file unless it says TRUNCATED. You must read an existing file COMPLETELY before overwriting it, and then send its full new content.
5. You must inspect a directory (get_directory_tree or list_directory) before creating a new file inside it.
6. Never guess the project's structure, framework or file layout; match the conventions found on disk. If a tool returns an error, fix the cause instead of continuing as if it succeeded. Central wiring files (app.module.ts, main.ts, ...) already exist somewhere: find the real one before creating a new one.
${this.hasThinkingTool() ? "7. For non-trivial tasks call sequentialthinking first (3-6 short thoughts), then act.\n" : ""}
When you are done and have no more actions to take, reply normally with a final summary and do NOT include an action block.`;
  }

  // Keeps the conversation under the context budget by eliding old bulky
  // messages (never the system prompt, first user message, or the last few turns).
  private compactHistory(messages: ChatMessage[]): void {
    let total = messages.reduce((n, m) => n + m.content.length, 0);
    if (total <= CONTEXT_CHAR_BUDGET) return;

    const protectedTail = 6;
    for (let i = 2; i < messages.length - protectedTail && total > CONTEXT_CHAR_BUDGET; i++) {
      const m = messages[i];
      if ((m.role === "tool" || m.role === "assistant") && m.content.length > 600) {
        const before = m.content.length;
        m.content =
          m.role === "tool"
            ? `[older tool output elided (${before} chars) — call the tool again if you still need it]`
            : `[older assistant message elided (${before} chars)]`;
        total -= before - m.content.length;
      }
    }
  }

  private readTree(relPath: string, maxDepth: number, state: SessionState): string {
    try {
      const { text, dirs } = this.fs.buildDirectoryTree(relPath, maxDepth);
      for (const d of dirs) state.dirsListed.add(d);
      return `${relPath === "." ? "./" : relPath + "/"}\n${text}`;
    } catch (err: any) {
      return `TOOL ERROR (directory did not exist): ${err.message}. Try get_directory_tree with path "." to see the real root, or find_files to search.`;
    }
  }

  // Splits a reply into the tool call(s) to run this turn. Consecutive read-only
  // calls run together; anything state-changing runs alone.
  private extractCalls(response: LLMResponse): { calls: ToolCall[]; discarded: number; incompleteBlock?: FileBlock } {
    const limit = (all: ToolCall[]) => {
      if (!READ_ONLY_TOOLS.has(all[0].name)) return { calls: [all[0]], discarded: all.length - 1 };
      const leading: ToolCall[] = [];
      for (const c of all) {
        if (!READ_ONLY_TOOLS.has(c.name)) break;
        leading.push(c);
      }
      return { calls: leading, discarded: all.length - leading.length };
    };

    if (response.toolCalls?.length) return limit(response.toolCalls);

    const block = parseFileBlock(response.content);
    if (block?.complete) {
      return {
        calls: [
          {
            id: `file-${Date.now()}`,
            name: block.tool,
            arguments: JSON.stringify({ path: block.path, content: block.content }),
          },
        ],
        discarded: 0,
      };
    }
    if (block && !block.complete) return { calls: [], discarded: 0, incompleteBlock: block };

    const fallback = parseFallbackActions(response.content);
    if (fallback.length) return limit(fallback);

    return { calls: [], discarded: 0 };
  }

  async run(agent: AgentDefinition, task: string): Promise<ExecutorResult> {
    const state = newSessionState();

    const stackPaths = detectStackKnowledge(this.workspaceRoot);
    if (stackPaths.length) {
      console.log(pc.dim(`Detected stack standards: ${stackPaths.map((p) => basename(p)).join(", ")}`));
    }
    const systemPrompt = this.buildSystemPrompt(agent, stackPaths);

    // Ground the agent in reality before it can guess: show the real tree as the
    // first thing it sees, so a small local model can't hallucinate a layout.
    const bootstrapTree = this.readTree(".", 2, state);

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Project tree (path ".", depth 2):\n${bootstrapTree}\n\nTask: ${task}` },
    ];

    let steps = 0;
    let nudges = 0;

    while (steps < MAX_STEPS) {
      steps++;
      this.compactHistory(messages);
      const response = await this.llm.chat(messages, this.toolSchemas);
      const { calls, discarded, incompleteBlock } = this.extractCalls(response);

      if (!calls.length) {
        // 1) A write block whose closing fence never arrived: the reply was cut off.
        if (incompleteBlock && nudges < MAX_NUDGES) {
          nudges++;
          console.log(pc.dim(`\n(The ${incompleteBlock.tool} block for ${incompleteBlock.path} was cut off — asking for smaller chunks.)`));
          messages.push({
            role: "assistant",
            content: response.content.slice(0, 1500) + "\n[... incomplete block omitted ...]",
          });
          messages.push({
            role: "user",
            content:
              `Your ${incompleteBlock.tool} block for ${incompleteBlock.path} was cut off (no closing fence), so NOTHING was written. ` +
              "Do not resend the whole file in one block. Write it in chunks: send write_file with ONLY the first ~120 lines " +
              "(a complete, properly closed block), then append_file for each following chunk of ~120 lines, one per turn.",
          });
          continue;
        }

        // 2) A write attempt that can't be parsed at all (e.g. path missing on the fence line).
        if (looksLikeMalformedFileBlock(response.content) && nudges < MAX_NUDGES) {
          nudges++;
          console.log(pc.dim("\n(Agent attempted a file block but it was malformed — nudging it to fix the format.)"));
          messages.push({ role: "assistant", content: response.content.slice(0, 1500) });
          messages.push({
            role: "user",
            content:
              "Your write_file/append_file block could not be read. The exact format is:\n" +
              "```write_file path/to/file.ts\n<raw file content>\n```\n" +
              "The opening fence line must be ```write_file (or ```append_file) followed by a space and the file path " +
              "(no quotes), then a newline, the raw content, and a closing ``` on its own line. Try again with exactly this format.",
          });
          continue;
        }

        // 3) Reasoning but neither action nor answer: nudge instead of ending silently.
        if (response.content.trim().length === 0 && nudges < MAX_NUDGES) {
          nudges++;
          console.log(pc.dim("\n(Agent produced no action or answer — nudging it to act.)"));
          messages.push({ role: "assistant", content: "(no output)" });
          messages.push({
            role: "user",
            content:
              "You did not call a tool or give a final answer. If you intended to explore further, actually emit that " +
              "action now (tool call or ```action block). Otherwise give your final answer as plain text.",
          });
          continue;
        }

        // 4) Hallucinated success: claims changes to files that were never written.
        const claimsCompletion = /\b(created|added|implemented|wrote|updated|modified|registered|wired|integrated)\b/i.test(
          response.content,
        );
        const mentionedFiles = extractMentionedFiles(response.content);
        const writtenBasenames = new Set(state.filesWritten.map(basename));
        const unfulfilledMentions = mentionedFiles.filter((f) => !writtenBasenames.has(basename(f)));
        const noWritesAtAll = state.filesWritten.length === 0 && state.commandsRun.length === 0;
        const partialFalseClaim = claimsCompletion && unfulfilledMentions.length > 0;

        if (((claimsCompletion && noWritesAtAll) || partialFalseClaim) && nudges < MAX_NUDGES) {
          nudges++;
          const detail = partialFalseClaim
            ? `You mentioned these file(s) but never actually called write_file for them: ${unfulfilledMentions.join(", ")}.`
            : "You have not actually called write_file or run_command yet — no changes have been made.";
          console.log(pc.dim(`\n(Agent claimed changes that weren't performed — pushing back: ${detail})`));
          messages.push({ role: "assistant", content: response.content });
          messages.push({
            role: "user",
            content:
              `${detail} If you intend to make that change, emit a real write_file (or run_command) action now, one at a time. ` +
              "Do not describe a file as changed until the corresponding tool call has actually succeeded for that exact file.",
          });
          continue;
        }

        if (response.finishReason === "length") {
          console.log(pc.yellow("\n(The final reply hit the token limit — raise AI_MAX_TOKENS if it looks cut off.)"));
        }
        console.log(pc.bold("\nAgent:"), response.content || "(no further action)");
        return {
          finalMessage: response.content,
          stepsTaken: steps,
          filesWritten: state.filesWritten,
          commandsRun: state.commandsRun,
        };
      }

      // Record the assistant turn (with the requested action(s)) in history.
      const assistantMsg: ChatMessage = { role: "assistant", content: response.content, toolCalls: calls };
      messages.push(assistantMsg);

      for (let i = 0; i < calls.length; i++) {
        const rawResult = await this.handleToolCall(calls[i], state, response.finishReason === "length");
        const result = clip(rawResult);

        // Once a write has succeeded the content lives on disk. Drop it from the
        // history (it would otherwise be re-sent to the model on every later turn,
        // twice: as reply text and as tool-call arguments).
        if (/^File (written|appended):/.test(rawResult)) {
          this.stripWrittenContent(calls[i]);
          if (calls[i].id.startsWith("file-")) assistantMsg.content = "";
        }

        const notice =
          i === calls.length - 1 && discarded > 0
            ? `\n\n(Note: you emitted ${discarded} additional action(s) this turn; they were NOT executed. ` +
              "Read-only tools can be batched, but write_file, append_file and run_command must be one per turn.)"
            : "";
        messages.push({ role: "tool", content: result + notice, toolCallId: calls[i].id });
      }
    }

    return {
      finalMessage: "Stopped: reached max step limit.",
      stepsTaken: steps,
      filesWritten: state.filesWritten,
      commandsRun: state.commandsRun,
    };
  }

  private stripWrittenContent(call: ToolCall): void {
    try {
      const a = JSON.parse(call.arguments);
      if (typeof a.content === "string") {
        a.content = `[${a.content.length} chars written to ${a.path}]`;
        call.arguments = JSON.stringify(a);
      }
    } catch {
      // leave as is
    }
  }

  // Last few lines of a file, so a chunked write knows exactly where to continue.
  private tailOf(p: string): string {
    try {
      const lines = this.fs.readFile(p).split("\n").filter((l) => l.trim() !== "");
      return lines
        .slice(-4)
        .map((l) => (l.length > 160 ? l.slice(0, 160) + "…" : l))
        .join("\n");
    } catch {
      return "";
    }
  }

  private summarizeArgs(args: Record<string, any>): string {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      out[k] = typeof v === "string" && v.length > 120 ? `${v.slice(0, 120)}… (${v.length} chars)` : v;
    }
    return JSON.stringify(out);
  }

  private async handleToolCall(call: ToolCall, state: SessionState, outputWasCutOff = false): Promise<string> {
    let args: Record<string, any>;
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch {
      return (
        `TOOL ERROR: could not parse the JSON arguments for ${call.name}${outputWasCutOff ? " (your output was cut off by the length limit)" : ""}. ` +
        "If you were writing a file, do NOT pass its content as a JSON argument: use a ```write_file path block " +
        "(and ```append_file chunks of ~150 lines for long files)."
      );
    }

    // Long content is summarized in the log; the diff/preview shows it in full.
    console.log(pc.dim(`\nAgent wants to run: ${call.name}(${this.summarizeArgs(args)})`));

    // Any unexpected throw must never crash the CLI; it goes back to the model
    // as a tool result so it can self-correct.
    try {
      return await this.dispatchToolCall(call.name, args, state);
    } catch (err: any) {
      return `TOOL ERROR: ${call.name} failed — ${err?.message ?? "unknown error"}. Check the arguments match the tool's schema and try again.`;
    }
  }

  private async dispatchToolCall(name: string, args: Record<string, any>, state: SessionState): Promise<string> {
    // MCP tools (e.g. sequentialthinking)
    if (this.mcp?.has(name)) return this.handleMcpTool(name, args, state);

    switch (name) {
      case "read_file": {
        const p = this.np(args.path);
        if (isSecretPath(p)) {
          return `TOOL ERROR: reading ${p} is blocked (secret env file). Read .env.example instead if you need the variable names.`;
        }
        try {
          const r = this.fs.readFileSlice(p, num(args.start_line), num(args.end_line));
          if (r.complete) state.filesRead.add(p);
          return r.text;
        } catch (err: any) {
          return `TOOL ERROR (path did not exist or could not be read): ${err.message}. Do not proceed as if this file exists — use get_directory_tree or find_files to locate the correct path.`;
        }
      }

      case "read_multiple_files": {
        if (!Array.isArray(args.paths) || args.paths.length === 0) {
          return 'TOOL ERROR: read_multiple_files requires "paths": an array of file paths.';
        }
        const all: string[] = args.paths.map((p: unknown) => this.np(p)).filter(Boolean);
        const allowed = all.filter((p) => !isSecretPath(p));
        const blocked = all.filter(isSecretPath);
        const { text, fullyRead } = this.fs.readMultipleDetailed(allowed);
        for (const p of fullyRead) state.filesRead.add(p);
        const blockedNote = blocked.map((p) => `--- FILE: ${p} ---\n[BLOCKED: secret env file]`).join("\n\n");
        return [text, blockedNote].filter(Boolean).join("\n\n");
      }

      case "list_directory": {
        const dirPath = this.np(args.path ?? ".");
        try {
          const entries = this.fs.listDirectory(dirPath);
          state.dirsListed.add(dirPath);
          return entries.map((e) => (e.isDirectory ? `${e.name}/` : e.name)).join("\n") || "(empty directory)";
        } catch (err: any) {
          return `TOOL ERROR (directory did not exist): ${err.message}. Try get_directory_tree with path "." to see the real root, or find_files to search.`;
        }
      }

      case "get_directory_tree": {
        const dirPath = this.np(args.path ?? args.rootDir ?? ".");
        return this.readTree(dirPath, num(args.maxDepth) ?? 3, state);
      }

      case "find_files": {
        const matches = this.search.findFiles(String(args.query ?? "")).filter((p) => !isSecretPath(p));
        return matches.length ? matches.join("\n") : `No files found matching "${args.query}".`;
      }

      case "grep": {
        const matches = this.search.grep(String(args.pattern ?? "")).filter((m) => !isSecretPath(m.file));
        return matches.length
          ? matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join("\n")
          : `No occurrences found for "${args.pattern}".`;
      }

      case "write_file":
        return this.handleWrite(false, args, state);

      case "append_file":
        return this.handleWrite(true, args, state);

      case "run_command": {
        console.log(`\n${pc.bold("Proposed command:")} ${pc.yellow(String(args.command))}`);
        if (args.reason) console.log(pc.dim(`Reason: ${args.reason}`));

        const approved = await confirm("Run this command?");
        if (!approved) {
          return "User rejected running this command. Do not repeat it; ask what to do differently or stop.";
        }
        const result = this.shell.run(String(args.command));
        state.commandsRun.push(String(args.command));
        console.log(result.stdout);
        if (result.stderr) console.log(pc.red(result.stderr));
        return JSON.stringify({
          exitCode: result.exitCode,
          stdout: result.stdout.slice(0, 4000),
          stderr: result.stderr.slice(0, 4000),
        });
      }

      default:
        return `TOOL ERROR: unknown tool ${name}. Available tools: ${this.toolSchemas.map((t) => t.name).join(", ")}.`;
    }
  }

  private async handleMcpTool(name: string, args: Record<string, any>, state: SessionState): Promise<string> {
    if (/think/i.test(name)) {
      state.thinkingCalls++;
      if (state.thinkingCalls > MAX_THINKING_CALLS) {
        return "NOTE: thinking budget for this task is used up. Stop planning and take the next concrete action now.";
      }
      const thought = typeof args.thought === "string" ? args.thought : "";
      console.log(pc.dim(`💭 thought ${args.thoughtNumber ?? "?"}/${args.totalThoughts ?? "?"}: ${thought.slice(0, 200)}`));
    } else if (!this.mcp!.autoApprove(name)) {
      console.log(`\n${pc.bold("Proposed MCP call:")} ${pc.yellow(name)} ${pc.dim(this.summarizeArgs(args))}`);
      if (!(await confirm(`Run MCP tool ${name}?`))) {
        return "User rejected this MCP tool call. Do not repeat it.";
      }
    }
    return this.mcp!.call(name, args);
  }

  // Closest ancestor of `dir` that actually exists (a NEW directory can't be listed).
  private nearestExistingDir(dir: string): string {
    let d = dir;
    while (d !== "." && !this.fs.isDirectory(d)) d = dirnameOf(d);
    return d;
  }

  private async handleWrite(append: boolean, args: Record<string, any>, state: SessionState): Promise<string> {
    const toolName = append ? "append_file" : "write_file";
    const p = this.np(args.path);

    if (!p || p === ".") return `TOOL ERROR: ${toolName} requires a file "path".`;
    if (typeof args.content !== "string" || args.content.trim() === "") {
      return `TOOL ERROR: ${toolName} requires non-empty string "content".`;
    }
    if (this.fs.isDirectory(p)) return `TOOL ERROR: ${p} is a directory, not a file.`;

    const content = ensureTrailingNewline(args.content.replace(/\r\n/g, "\n"));
    const exists = this.fs.fileExists(p);

    // Hard gate: no abbreviation placeholders (they would delete real code).
    if (!p.toLowerCase().endsWith(".md") && PLACEHOLDER_RE.test(content)) {
      return (
        `TOOL ERROR: refused to write ${p} — it contains a placeholder comment such as "rest of file" / "existing code". ` +
        "Placeholders replace real code with nothing. Write the complete real content instead; for long files use " +
        "write_file with the first ~150 lines and append_file for the remaining chunks."
      );
    }

    if (append) return this.handleAppend(p, content, exists, state);

    // Gate 1: never blindly overwrite a file that hasn't been read completely.
    if (exists && !state.filesRead.has(p)) {
      return `TOOL ERROR: refused to write ${p} — this file already exists and you have not read all of it in this session. Call read_file("${p}") first (if it says TRUNCATED, read the remaining line ranges too), then propose the edit based on its real content.`;
    }

    if (!exists) {
      // Gate 2: no new files in directories the agent never inspected. A directory
      // that doesn't exist yet is checked via its closest existing parent.
      const dir = dirnameOf(p);
      if (dir !== ".") {
        const anchor = this.nearestExistingDir(dir);
        if (!state.dirsListed.has(anchor)) {
          const where = anchor === dir ? `"${dir}"` : `"${anchor}" (the closest existing parent of the new directory "${dir}")`;
          return `TOOL ERROR: refused to create ${p} — you have not inspected ${where} yet, so you don't know its conventions. Call get_directory_tree or list_directory on "${anchor}" first.`;
        }
      }

      // Gate 3: imports of a brand-new code file must match the project's declared
      // dependencies. Warn once; a deliberate repeat of the same write is allowed.
      if (CODE_FILE_RE.test(p) && !state.warnedUnknownDeps.has(p)) {
        if (state.declaredDependencies === null) state.declaredDependencies = this.computeDeclaredDependencies();
        const nodeBuiltins = new Set(builtinModules);
        const unknown = extractImportedPackages(content).filter(
          (pkg) => !state.declaredDependencies!.has(pkg) && !nodeBuiltins.has(pkg),
        );
        if (unknown.length > 0 && state.declaredDependencies.size > 0) {
          state.warnedUnknownDeps.add(p);
          return (
            `TOOL ERROR: refused to create ${p} — it imports ${unknown.join(", ")}, which no package.json in this project ` +
            `declares. This usually means you're guessing a framework/library the project doesn't use. Check an existing file ` +
            `nearby with read_file to see what it imports and match that. If you are certain ${unknown.join(", ")} is correct, ` +
            "propose this exact same write_file again and it will be allowed."
          );
        }
      }

      // Gate 4: a same-named file elsewhere usually means a guessed path. Warn once.
      if (!DUPLICATE_NAME_EXEMPT.test(basename(p)) && !state.warnedDuplicatePaths.has(p)) {
        const candidates = this.search.findFiles(basename(p)).filter((c) => c !== p && basename(c) === basename(p));
        if (candidates.length > 0) {
          state.warnedDuplicatePaths.add(p);
          return (
            `TOOL ERROR: refused to create ${p} — a file with the same name already exists at: ${candidates.join(", ")}. ` +
            "That is very likely the real file to read and edit instead of creating one at a guessed path. If you are certain " +
            `${p} is genuinely a separate new file, propose this exact same write_file again and it will be allowed.`
          );
        }
      }
    }

    const oldContent = exists ? this.fs.readFile(p) : "";

    // No-op: identical content needs no approval.
    if (exists && oldContent.trimEnd() === content.trimEnd()) {
      if (!state.filesWritten.includes(p)) state.filesWritten.push(p);
      console.log(pc.dim(`\n${p} already contains this exact content — skipping (no prompt needed).`));
      return `NOTE: ${p} already contains exactly this content. Nothing was changed. Do NOT propose this same write again — move on to the next necessary step, or finish with a final answer.`;
    }

    // Shrink guard: a big file replaced by something much shorter usually means
    // the model dropped code. Warn once; a repeat is allowed.
    const oldLines = oldContent.split("\n").length;
    const newLines = content.split("\n").length;
    if (exists && oldLines > 40 && newLines < oldLines * 0.5 && !state.warnedShrink.has(p)) {
      state.warnedShrink.add(p);
      return (
        `TOOL ERROR: ${p} currently has ${oldLines} lines but your replacement has only ${newLines}. That looks like dropped code. ` +
        "If the shrink is intentional, or you are rewriting this file in chunks (first chunk here, the rest via append_file), propose this exact same write_file again. Otherwise re-read the file and write the complete content."
      );
    }

    const diff = renderDiff(p, oldContent, content);
    console.log(`\n${pc.bold(exists ? "Proposed edit:" : "Proposed new file:")} ${p} (${newLines - 1} lines)\n`);
    console.log(diff || pc.dim("(no textual diff — identical content)"));

    if (!(await confirm(`Apply this change to ${p}?`))) {
      return "User rejected this file write. Do not repeat the same change; ask what to do differently or stop.";
    }

    this.fs.commitWrite(p, content);
    state.filesRead.add(p);
    if (!state.filesWritten.includes(p)) state.filesWritten.push(p);
    return `File written: ${p} (${newLines - 1} lines). The file now ends with:\n${this.tailOf(p)}\nIf this is only the first chunk of a longer file, continue with append_file starting right after these lines; otherwise move on.`;
  }

  private async handleAppend(p: string, content: string, exists: boolean, state: SessionState): Promise<string> {
    if (!exists || !state.filesWritten.includes(p)) {
      return `TOOL ERROR: append_file only continues a file you already created or overwrote with write_file in this session (${p} is not one). Use write_file first.`;
    }

    const lines = content.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const preview = lines.slice(0, 40).map((l) => pc.green(`+${l}`));
    console.log(`\n${pc.bold("Proposed append:")} ${p} (+${lines.length} lines)\n`);
    console.log(preview.join("\n"));
    if (lines.length > 40) console.log(pc.dim(`… (+${lines.length - 40} more lines)`));

    if (!(await confirm(`Append these ${lines.length} lines to ${p}?`))) {
      return "User rejected this append. Do not repeat the same change; ask what to do differently or stop.";
    }

    this.fs.appendToFile(p, content);
    const total = this.fs.readFile(p).split("\n").length - 1;
    return `File appended: ${p} (+${lines.length} lines, ${total} lines total). The file now ends with:\n${this.tailOf(p)}\nIf more content remains, call append_file with the next chunk starting right after these lines; otherwise move on.`;
  }
}
