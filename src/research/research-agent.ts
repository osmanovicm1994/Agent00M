// src/research/research-agent.ts
//
// The research stage. It runs FIRST, before any plan:
//
//   user query ──► redact secrets ──► probe workspace (file names only) ──► Gemini + Google Search grounding
//                                                                              │
//                                                       ResearchBrief + the pages Google used ◄─┘
//
// Gemini searches Google through its own grounding tool, so there is no scraping, no browser and no CAPTCHA.
// If anything fails (no key, no network, quota, bad JSON) it returns null and the caller carries on: research can
// never block work.
//
// PRIVACY: this is a place where data leaves the machine. What is sent: the query and a file-name overview of the
// project (see gateway/workspace-probe.ts), both with secret-looking values masked. The stage is OFF unless you turn
// it on (AGENT_RESEARCH=on, `run --research`, the chat prompt or /research).

import pc from "picocolors";
import { AGENTS, getAgent } from "../agents/definitions";
import type { GeminiTriageClient } from "../gateway/gemini";
import { redactSecrets } from "../gateway/redact";
import { buildResearchInstruction } from "./instruction";
import { printResearchSummary } from "./render";
import { fallbackBrief, parseBrief, type ResearchBrief, type ResearchSource } from "./types";
import { escapeTags, maskedFingerprint } from "./util";

export interface PreviousTurn {
  task: string;
  conclusion: string;
}

export interface ResearchOutcome {
  brief: ResearchBrief;
  /** Pages Google used for the answer (real URLs, resolved from Google's redirect links). */
  sources: ResearchSource[];
  /** The searches Gemini ran. */
  queries: string[];
  /** A valid local agent id suggested by the brief (lets the CLI skip the local routing call). */
  recommendedAgent?: string;
  model: string;
  ms: number;
  redactions: number;
  grounded: boolean;
  /** Set when Google Search could not be used (for example the grounding quota is used up). */
  note?: string;
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/** Grounding links are Google redirects; the Location header of the redirect is the real page. */
async function resolveUrl(url: string): Promise<string> {
  if (!/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect/i.test(url)) return url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const res = await fetch(url, { redirect: "manual", signal: controller.signal, headers: { "User-Agent": UA } });
    return res.headers.get("location") ?? url;
  } catch {
    return url;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveSources(sources: ResearchSource[]): Promise<ResearchSource[]> {
  const resolved = await Promise.all(sources.slice(0, 8).map(async (s) => ({ title: s.title, url: await resolveUrl(s.url) })));
  const seen = new Set<string>();
  return resolved.filter((s) => {
    if (!/^https?:\/\//i.test(s.url) || seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

export class ResearchAgent {
  constructor(private readonly client: GeminiTriageClient) {}

  /**
   * Understands `task`, searches Google where it matters and returns the brief, or null if the stage could not run
   * (a warning is printed; the caller continues without a brief).
   */
  async run(task: string, workspaceRoot: string, previous?: PreviousTurn): Promise<ResearchOutcome | null> {
    const started = Date.now();
    // Off by default: Gemini's Google Search has a small free quota that this stage would use up on every task.
    const grounding = /^(1|on|true|yes)$/i.test((process.env.AGENT_RESEARCH_GROUNDING ?? "").trim());
    console.log(pc.dim(grounding ? "🔎 Research: Gemini is analysing the request and searching Google …" : "🔎 Research: Gemini is analysing the request …"));

    try {
      // 1. Nothing leaves the machine before this step.
      const query = redactSecrets(task);
      const fingerprint = maskedFingerprint(workspaceRoot);
      const prev = previous ? redactSecrets(`Request: ${previous.task}\nConclusion: ${previous.conclusion}`) : { text: "", count: 0 };

      // 2. One user message with clearly separated, tagged blocks (the system instruction explains them).
      const content = [
        `<user_query>\n${escapeTags(query.text)}\n</user_query>`,
        `<workspace_fingerprint>\n${escapeTags(fingerprint.text)}\n</workspace_fingerprint>`,
        prev.text ? `<previous_turn>\n${escapeTags(prev.text)}\n</previous_turn>` : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      // 3. Gemini answers (searching Google where it needs to); parse leniently, never lose the answer.
      const res = await this.client.research(
        buildResearchInstruction(AGENTS.map((a) => ({ id: a.id, description: a.description }))),
        content,
        { grounding },
      );
      let brief: ResearchBrief;
      try {
        brief = parseBrief(res.text);
      } catch {
        brief = fallbackBrief(res.text);
      }
      const sources = await resolveSources(res.sources);
      // Without a real search the "facts" are the model's memory: never present them as verified.
      if (!res.grounded) brief = { ...brief, findings: brief.findings.map((f) => ({ ...f, confidence: "low" })) };

      const outcome: ResearchOutcome = {
        brief,
        sources,
        queries: res.queries,
        recommendedAgent: getAgent(brief.recommendedAgent.trim())?.id,
        model: res.model,
        ms: Date.now() - started,
        redactions: query.count + fingerprint.count + prev.count,
        grounded: res.grounded,
        note: res.note,
      };
      printResearchSummary(brief, {
        model: outcome.model,
        ms: outcome.ms,
        redactions: outcome.redactions,
        grounded: outcome.grounded,
        note: outcome.note,
        queries: outcome.queries,
        sourceCount: sources.length,
        recommendedAgent: outcome.recommendedAgent,
      });
      return outcome;
    } catch (err: any) {
      console.log(pc.yellow(`⚠ Research skipped: ${err?.message ?? err}\n  Continuing with the local agent only.\n`));
      return null;
    }
  }
}
