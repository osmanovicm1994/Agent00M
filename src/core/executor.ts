import type { ChatMessage, LLMProvider, ToolCall } from "../llm/types";
import type { AgentDefinition } from "../agents/definitions";
import { FsTools, fsToolSchemas } from "../tools/fs.tool";
import { ShellTool, shellToolSchema } from "../tools/shell.tool";
import { SearchTool, searchToolSchemas } from "../tools/search.tool";
import { renderDiff } from "./diff";
import prompts from "prompts";
import pc from "picocolors";
import { builtinModules } from "module";

const ALL_TOOL_SCHEMAS = [...fsToolSchemas, shellToolSchema, ...searchToolSchemas];

const MAX_STEPS = 15;

// Some local models (including several DeepSeek R1 quantizations in LM
// Studio) won't emit proper OpenAI-style tool_calls even when a `tools`
// array is passed. As a fallback, we also ask the model to emit action
// requests as a fenced ```action json block and parse that if no native
// tool_calls came back. Models sometimes emit MORE THAN ONE action block in
// a single turn despite being told not to — we only ever take the first one
// and explicitly tell the model the rest were ignored, so nothing silently
// gets lost or double-applied.
//
// write_file gets its OWN dedicated raw-text block format instead of JSON.
// Asking a small local model to JSON-encode an entire source file (escaping
// every quote, newline, and backslash) as a string field is exactly where
// generation reliably breaks — the write attempt either never appears, or
// silently fails JSON.parse and gets dropped with no feedback. A raw fenced
// block needs zero escaping, which is far more reliable for this model.
const WRITE_FILE_BLOCK_RE = /```write_file\s+(\S+)\s*\n([\s\S]*?)```/;

function parseWriteFileBlock(content: string): ToolCall | null {
  const match = content.match(WRITE_FILE_BLOCK_RE);
  if (!match) return null;
  const [, filePath, fileContent] = match;
  return {
    id: `write-${Date.now()}`,
    name: "write_file",
    arguments: JSON.stringify({ path: filePath, content: fileContent.replace(/\n$/, "") }),
  };
}

// Detects a write_file attempt that is present but malformed (e.g. missing
// the path on the opening fence line, or the closing ``` never appears), so
// we can tell the model exactly what to fix instead of silently ignoring it.
function looksLikeMalformedWriteFileBlock(content: string): boolean {
  return content.includes("```write_file") && !WRITE_FILE_BLOCK_RE.test(content);
}

function parseFallbackActions(content: string): ToolCall[] {
  const blocks = [...content.matchAll(/```action\s*([\s\S]*?)```/g)];
  const calls: ToolCall[] = [];
  blocks.forEach((match, idx) => {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (typeof parsed.tool !== "string") return;
      calls.push({
        id: `fallback-${Date.now()}-${idx}`,
        name: parsed.tool,
        arguments: JSON.stringify(parsed.arguments ?? {}),
      });
    } catch {
      // Malformed JSON in this block — skip it rather than aborting the
      // whole parse; other, well-formed blocks in the same message should
      // still be usable.
    }
  });
  return calls;
}

// Extracts filename-like tokens (e.g. app.module.ts, src/health/health.ts)
// from the model's own prose. Used to catch a specific, dangerous case: the
// model claims to have modified a named file that was never actually in
// filesWritten — e.g. "Updated app.module.ts" when only health.controller.ts
// was ever really written. A blanket "were any writes made at all" check
// isn't enough once at least one real write happened this session.
const FILE_MENTION_RE = /\b[\w.\/-]+\.(?:ts|tsx|js|jsx|json)\b/g;

function extractMentionedFiles(content: string): string[] {
  return [...new Set([...content.matchAll(FILE_MENTION_RE)].map((m) => m[0]))];
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

// Returns "." for a top-level file, otherwise the parent directory path.
function dirnameOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "." : p.slice(0, idx);
}

// Extracts bare (non-relative) import/require specifiers from source content
// — e.g. 'fastify', '@nestjs/common' — used to sanity-check a new file's
// imports against what the project actually depends on, so a model can't
// silently fabricate code for a framework the project doesn't use.
const IMPORT_RE = /(?:from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|^import\s+['"]([^'"]+)['"])/gm;

function extractImportedPackages(content: string): string[] {
  const specifiers = new Set<string>();
  for (const match of content.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec) specifiers.add(spec);
  }
  const packages = new Set<string>();
  for (const spec of specifiers) {
    if (spec.startsWith(".") || spec.startsWith("/")) continue; // relative import, not a dependency
    const clean = spec.startsWith("node:") ? spec.slice(5) : spec;
    if (clean.startsWith("@")) {
      const parts = clean.split("/");
      packages.add(parts.slice(0, 2).join("/"));
    } else {
      packages.add(clean.split("/")[0]);
    }
  }
  return [...packages];
}

async function confirm(message: string): Promise<boolean> {
  const response = await prompts({
    type: "confirm",
    name: "ok",
    message,
    initial: false,
  });
  return Boolean(response.ok);
}

export interface ExecutorResult {
  finalMessage: string;
  stepsTaken: number;
  filesWritten: string[];
  commandsRun: string[];
}

// All mutable, per-run bookkeeping the executor needs to catch a model's bad
// behavior (guessing paths, guessing frameworks, lying about completion,
// looping on no-ops). Consolidated into one object instead of threading
// separate parameters through every method.
interface SessionState {
  filesRead: Set<string>;
  filesWritten: string[];
  commandsRun: string[];
  // Directories the agent has actually listed. Writing a NEW file into a
  // directory that was never listed is blocked — this is what let the model
  // silently fabricate apps/api/src/index.ts and health.controller.ts
  // without ever having looked inside apps/api/src.
  dirsListed: Set<string>;
  // Paths already warned about once for having a same-named file elsewhere
  // in the project. Second attempt at the exact same path is let through.
  warnedDuplicatePaths: Set<string>;
  // Paths already warned about once for importing a package the project
  // doesn't declare a dependency on anywhere. Second attempt is let through.
  warnedUnknownDeps: Set<string>;
  // Lazily computed union of every package.json's dependencies in the
  // project. null until first computed; empty set if none found/parseable.
  declaredDependencies: Set<string> | null;
}

function newSessionState(): SessionState {
  return {
    filesRead: new Set(),
    filesWritten: [],
    commandsRun: [],
    dirsListed: new Set(["."]),
    warnedDuplicatePaths: new Set(),
    warnedUnknownDeps: new Set(),
    declaredDependencies: null,
  };
}

export class Executor {
  private fs: FsTools;
  private shell: ShellTool;
  private search: SearchTool;

  constructor(private readonly llm: LLMProvider, workspaceRoot: string) {
    this.fs = new FsTools(workspaceRoot);
    this.shell = new ShellTool(workspaceRoot);
    this.search = new SearchTool(workspaceRoot);
  }

  // Scans every package.json in the project (deps/devDeps/peerDeps) and
  // returns the union of declared package names. Best-effort: any read or
  // parse failure is swallowed and that file just contributes nothing.
  private computeDeclaredDependencies(): Set<string> {
    const result = new Set<string>();
    const packageJsonPaths = this.search.findFiles("package.json", 50).filter((p) => basename(p) === "package.json");
    for (const p of packageJsonPaths) {
      try {
        const raw = this.fs.readFile(p);
        const parsed = JSON.parse(raw);
        for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
          const deps = parsed[section];
          if (deps && typeof deps === "object") {
            for (const name of Object.keys(deps)) result.add(name);
          }
        }
      } catch {
        // Unreadable or malformed package.json — skip it.
      }
    }
    return result;
  }

  async run(agent: AgentDefinition, task: string): Promise<ExecutorResult> {
    const systemPrompt = `${agent.systemPrompt}

You have access to these tools: ${ALL_TOOL_SCHEMAS.map((t) => t.name).join(", ")}.
If your runtime does not support native tool calls, use one of these two fenced-block formats
instead:

For read_file, list_directory, find_files, grep, run_command (simple arguments):
\`\`\`action
{"tool": "read_file", "arguments": {"path": "src/index.ts"}}
\`\`\`

For write_file specifically, do NOT use the \`\`\`action JSON format — do not JSON-encode the file
content. Instead use this dedicated raw block, with the path on the opening fence line and the
full raw file content below it (no escaping, no quotes needed):
\`\`\`write_file path/to/file.ts
import { Something } from './somewhere';

// ...the complete, real file content goes here, verbatim...
\`\`\`

Only one action per turn. When you are done and have no more actions to take, reply normally
with a final summary and do NOT include an action block.

CRITICAL: Never guess the project's structure, framework, or file layout. The first message
below already shows you the real root directory listing — read it carefully. You MUST call
list_directory on the actual subdirectory you intend to write into (e.g. apps/api/src) before
creating any file there — writing into a directory you have never listed will be REJECTED.
Match the project's existing conventions (frameworks, folder layout, naming) exactly as found
on disk — do not default to generic examples (Express, Fastify, a default Nest CLI layout)
without confirming what the project actually uses. If a read_file or list_directory call
returns an error, do not proceed as if it succeeded — look for the correct path instead.
Central wiring files (app.module.ts, main.ts, etc.) usually exist already somewhere in the
project — find the real one with list_directory or find_files before ever proposing to create
a new one.

CRITICAL: you MUST call read_file on an existing file before you propose write_file for that
same path. Writing to an existing file you have not read will be REJECTED. This applies
especially to shared/central files like app.module.ts, index.ts, or any config/registration
file — read the current content first so your proposed full-file replacement preserves
everything already there (existing imports, providers, modules) and only adds what the task
needs.

CRITICAL: emit exactly ONE action per turn (one tool call, one \`\`\`action block, or one
\`\`\`write_file block) and then stop and wait for its result. Do not emit multiple blocks in
the same reply — only the first will run and the rest will be discarded.`;

    const state = newSessionState();

    // Ground the agent in reality before it can guess: always show the real
    // root listing as the first thing it sees, so a small/local model can't
    // hallucinate a generic (e.g. Express/Fastify, or default Nest CLI)
    // layout for an unfamiliar project.
    const rootListing = await this.handleToolCall(
      { id: "bootstrap", name: "list_directory", arguments: JSON.stringify({ path: "." }) },
      state,
    );

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Project root listing (path "."): ${rootListing}\n\nTask: ${task}`,
      },
    ];

    let steps = 0;
    while (steps < MAX_STEPS) {
      steps++;
      const response = await this.llm.chat(messages, ALL_TOOL_SCHEMAS);

      let toolCalls: ToolCall[] = response.toolCalls?.length ? [response.toolCalls[0]] : [];
      let discardedCount = 0;
      if (!toolCalls.length) {
        const writeCall = parseWriteFileBlock(response.content);
        if (writeCall) {
          toolCalls = [writeCall];
        } else {
          const fallbackCalls = parseFallbackActions(response.content);
          if (fallbackCalls.length) {
            toolCalls = [fallbackCalls[0]];
            discardedCount = fallbackCalls.length - 1;
          }
        }
      }
      const toolCall = toolCalls[0] ?? null;

      if (!toolCall) {
        // The model tried to write a file but the block was malformed (bad
        // opening fence, missing path, unterminated block). Tell it exactly
        // what's wrong instead of silently discarding the attempt.
        if (looksLikeMalformedWriteFileBlock(response.content) && steps < MAX_STEPS) {
          console.log(
            pc.dim("\n(Agent attempted a write_file block but it was malformed — nudging it to fix the format.)"),
          );
          messages.push({ role: "assistant", content: response.content });
          messages.push({
            role: "user",
            content:
              "Your ```write_file block was malformed and could not be read. The exact format is:\n" +
              "```write_file path/to/file.ts\n<raw file content>\n```\n" +
              "The opening fence line must be exactly ```write_file followed by a space and the file path " +
              "(no quotes), then a newline, then the raw content, then a closing ``` on its own line. " +
              "Try again with exactly this format.",
          });
          continue;
        }

        const looksLikeRealAnswer = response.content.trim().length > 0;

        // Guard against a failure mode where a reasoning model "thinks" about
        // what it will do next but never actually emits an action or a real
        // final answer. Nudge it once instead of silently ending the task.
        if (!looksLikeRealAnswer && steps < MAX_STEPS) {
          console.log(pc.dim("\n(Agent produced reasoning but no action or answer — nudging it to act.)"));
          messages.push({ role: "assistant", content: response.reasoning ?? "" });
          messages.push({
            role: "user",
            content:
              "You did not call a tool or give a final answer. If you intended to explore further " +
              "(e.g. list_directory or read_file), actually emit that action now using the tool-call " +
              "format or the ```action block. Otherwise, give your final answer as plain text.",
          });
          continue;
        }

        // Guard against the model narrating changes to specific files that
        // were never actually written this session (full or partial
        // hallucinated success summary).
        const claimsCompletion = /\b(created|added|implemented|wrote|updated|modified|registered|wired|integrated)\b/i.test(
          response.content,
        );
        const mentionedFiles = extractMentionedFiles(response.content);
        const writtenBasenames = new Set(state.filesWritten.map(basename));
        const unfulfilledMentions = mentionedFiles.filter((f) => !writtenBasenames.has(basename(f)));

        const noWritesAtAll = state.filesWritten.length === 0 && state.commandsRun.length === 0;
        const partialFalseClaim = claimsCompletion && unfulfilledMentions.length > 0;

        if ((claimsCompletion && noWritesAtAll) || (partialFalseClaim && steps < MAX_STEPS)) {
          const detail = partialFalseClaim
            ? `You mentioned these file(s) but never actually called write_file for them: ${unfulfilledMentions.join(", ")}.`
            : "You have not actually called write_file or run_command yet — no changes have been made.";
          console.log(
            pc.dim(`\n(Agent claimed to make changes that weren't actually performed — pushing back: ${detail})`),
          );
          messages.push({ role: "assistant", content: response.content });
          messages.push({
            role: "user",
            content:
              `${detail} If you intend to make that change, you must emit a real write_file (or run_command) ` +
              "action now, one at a time. Do not describe a file as changed until the corresponding write_file " +
              "call has actually succeeded for that exact file.",
          });
          continue;
        }

        // No action requested and the model gave a real, non-fabricated answer — done.
        console.log(pc.bold("\nAgent:"), response.content || "(no further action)");
        return {
          finalMessage: response.content,
          stepsTaken: steps,
          filesWritten: state.filesWritten,
          commandsRun: state.commandsRun,
        };
      }

      // Record the assistant's turn (including the requested action) in history.
      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: [toolCall],
      });

      const result = await this.handleToolCall(toolCall, state);

      const resultWithNotice =
        discardedCount > 0
          ? `${result}\n\n(Note: you emitted ${discardedCount} additional action block(s) in this turn; only the first was executed. Emit ONE action per turn and wait for its result.)`
          : result;

      messages.push({
        role: "tool",
        content: resultWithNotice,
        toolCallId: toolCall.id,
      });
    }

    return {
      finalMessage: "Stopped: reached max step limit.",
      stepsTaken: steps,
      filesWritten: state.filesWritten,
      commandsRun: state.commandsRun,
    };
  }

  private async handleToolCall(call: ToolCall, state: SessionState): Promise<string> {
    let args: Record<string, any>;
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch {
      return `TOOL ERROR: could not parse arguments for ${call.name}. Arguments must be valid JSON matching the tool's schema.`;
    }

    console.log(pc.dim(`\nAgent wants to run: ${call.name}(${JSON.stringify(args)})`));

    // Any unexpected throw here (missing/wrong-typed args, a bad regex, etc.)
    // must never crash the whole CLI — it goes back to the model as a tool
    // result so it can self-correct.
    try {
      return await this.dispatchToolCall(call.name, args, state);
    } catch (err: any) {
      return `TOOL ERROR: ${call.name} failed — ${err?.message ?? "unknown error"}. Check the arguments match the tool's schema and try again.`;
    }
  }

  private async dispatchToolCall(name: string, args: Record<string, any>, state: SessionState): Promise<string> {
    switch (name) {
      case "read_file": {
        try {
          const content = this.fs.readFile(args.path);
          state.filesRead.add(args.path);
          return content;
        } catch (err: any) {
          return `TOOL ERROR (path did not exist or could not be read): ${err.message}. Do not proceed as if this file exists — use list_directory or find_files to locate the correct path.`;
        }
      }

      case "list_directory": {
        try {
          const dirPath = args.path ?? ".";
          const entries = this.fs.listDirectory(dirPath);
          state.dirsListed.add(dirPath);
          return JSON.stringify(entries);
        } catch (err: any) {
          return `TOOL ERROR (directory did not exist): ${err.message}. Try list_directory(".") to see the real root, or find_files to search.`;
        }
      }

      case "find_files": {
        return JSON.stringify(this.search.findFiles(args.query));
      }

      case "grep": {
        return JSON.stringify(this.search.grep(args.pattern));
      }

      case "write_file": {
        const exists = this.fs.fileExists(args.path);

        // Hard gate 1: refuse to blindly overwrite a file the agent hasn't
        // actually read in this session. This is what previously let the
        // model guess a whole new app.module.ts and wipe out unrelated
        // modules/providers it never looked at.
        if (exists && !state.filesRead.has(args.path)) {
          return `TOOL ERROR: refused to write ${args.path} — this file already exists and you have not read it yet in this session. Call read_file("${args.path}") first, then propose an edit based on its real content.`;
        }

        if (!exists) {
          const dir = dirnameOf(args.path);

          // Hard gate 2: refuse to create a NEW file inside a directory the
          // agent has never actually looked at. This is what let the model
          // fabricate apps/api/src/index.ts and health.controller.ts (with
          // the wrong framework entirely) without ever listing
          // apps/api/src. Unlike the other guards, this one is not a
          // warn-once-then-allow — satisfying it is a single trivial
          // list_directory call, so there's no reason to ever bypass it.
          if (dir !== "." && !state.dirsListed.has(dir)) {
            return `TOOL ERROR: refused to create ${args.path} — you have not called list_directory("${dir}") yet, so you don't actually know what's in that directory or what conventions/framework it uses. Call list_directory("${dir}") first.`;
          }

          // Hard gate 3: for a brand-new file, sanity-check its imports
          // against what the project actually depends on anywhere
          // (package.json dependencies/devDependencies/peerDependencies).
          // This is what let the model fabricate a Fastify-based handler
          // for a NestJS project — nothing forced it to check its own
          // assumptions about the framework. Warn once; a deliberate repeat
          // of the exact same path is let through (project may simply be
          // adding a genuinely new dependency).
          if (!state.warnedUnknownDeps.has(args.path)) {
            if (state.declaredDependencies === null) {
              state.declaredDependencies = this.computeDeclaredDependencies();
            }
            const imported = extractImportedPackages(args.content ?? "");
            const nodeBuiltins = new Set(builtinModules);
            const unknown = imported.filter((pkg) => !state.declaredDependencies!.has(pkg) && !nodeBuiltins.has(pkg));
            if (unknown.length > 0 && state.declaredDependencies!.size > 0) {
              state.warnedUnknownDeps.add(args.path);
              return (
                `TOOL ERROR: refused to create ${args.path} — it imports ${unknown.join(", ")}, which no ` +
                `package.json in this project declares as a dependency. This usually means you're guessing a ` +
                `framework/library the project doesn't actually use. Check an existing file in this directory (or ` +
                `a nearby one) with read_file to see what's actually imported there, and match that instead. If ` +
                `you are certain ${unknown.join(", ")} is correct, propose this exact same write_file again and it ` +
                `will be allowed.`
              );
            }
          }
        }

        // Second gate, for NEW files only: if a file with the same basename
        // already exists somewhere else in the project, this is very likely
        // the model guessing a fake/generic path instead of finding and
        // editing the real one. Warn once; a deliberate repeat is allowed.
        if (!exists && !state.warnedDuplicatePaths.has(args.path)) {
          const candidates = this.search
            .findFiles(basename(args.path))
            .filter((p) => p !== args.path && basename(p) === basename(args.path));
          if (candidates.length > 0) {
            state.warnedDuplicatePaths.add(args.path);
            return (
              `TOOL ERROR: refused to create ${args.path} — a file with the same name already exists at: ` +
              `${candidates.join(", ")}. This is very likely the real file you should read and edit instead of ` +
              `creating a new one at a guessed path. Call read_file on the existing path first. If you are certain ` +
              `${args.path} is genuinely meant to be a separate, new file, propose this exact same write_file again ` +
              `and it will be allowed.`
            );
          }
        }

        const oldContent = exists ? this.fs.readFile(args.path) : "";

        // Short-circuit a no-op write: if the proposed content is byte-
        // identical to what's already on disk, there is nothing to approve.
        if (exists && oldContent === args.content) {
          if (!state.filesWritten.includes(args.path)) state.filesWritten.push(args.path);
          console.log(pc.dim(`\n${args.path} already contains this exact content — skipping (no prompt needed).`));
          return `NOTE: ${args.path} already contains exactly this content. Nothing was changed because there was nothing to change. Do NOT propose this same write again — move on to the next necessary step for the task (e.g. a different file, or finish with a final answer if nothing else is needed).`;
        }

        const diff = renderDiff(args.path, oldContent, args.content);
        console.log(`\n${pc.bold(exists ? "Proposed edit:" : "Proposed new file:")} ${args.path}\n`);
        console.log(diff || pc.dim("(no textual diff — identical content)"));

        const approved = await confirm(`Apply this change to ${args.path}?`);
        if (!approved) {
          return "User rejected this file write. Do not repeat the same change; ask what to do differently or stop.";
        }
        this.fs.commitWrite(args.path, args.content);
        state.filesRead.add(args.path);
        state.filesWritten.push(args.path);
        return `File written: ${args.path}`;
      }

      case "run_command": {
        console.log(`\n${pc.bold("Proposed command:")} ${pc.yellow(args.command)}`);
        if (args.reason) console.log(pc.dim(`Reason: ${args.reason}`));

        const approved = await confirm("Run this command?");
        if (!approved) {
          return "User rejected running this command. Do not repeat it; ask what to do differently or stop.";
        }
        const result = this.shell.run(args.command);
        state.commandsRun.push(args.command);
        console.log(result.stdout);
        if (result.stderr) console.log(pc.red(result.stderr));
        return JSON.stringify({
          exitCode: result.exitCode,
          stdout: result.stdout.slice(0, 4000),
          stderr: result.stderr.slice(0, 4000),
        });
      }

      default:
        return `TOOL ERROR: unknown tool ${name}. Available tools: ${ALL_TOOL_SCHEMAS.map((t) => t.name).join(", ")}.`;
    }
  }
}
