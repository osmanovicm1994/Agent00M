// src/vision/describe.ts
//
// "Here is a picture of what I want": turns a screenshot, mockup or sketch into a written design
// brief (layout, components, colours, typography, states) that the coding agents can build from.
// The coding model (e.g. Qwen3-Coder) cannot see images, so a vision model reads the picture once
// and everything after that works with text.
//
// Two readers, local first:
//  1. LOCAL  AI_VISION_MODEL=<id of a vision model loaded in LM Studio>   (nothing leaves the machine)
//  2. CLOUD  Gemini, only with GEMINI_API_KEY and only after you confirm: the image is sent to Google.
//
// The brief is a best-effort reading, not pixel measurement: colours are estimates, sizes are relative.

import * as fs from "fs";
import * as path from "path";
import OpenAI from "openai";
import pc from "picocolors";
import prompts from "prompts";
import { GeminiTriageClient } from "../gateway/gemini";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface DesignBrief {
  imagePath: string;
  /** The text handed to the agents. */
  brief: string;
  /** Which reader produced it, e.g. "local: qwen2.5-vl-7b" or "gemini-3.5-flash". */
  source: string;
}

const READER_SYSTEM = `You are a UI/UX analyst. You look at ONE image (a screenshot, mockup, wireframe or sketch) and write a design brief that a developer who CANNOT see the image can build from.

Rules:
- Describe only what is visible. If something is unclear or cut off, say "unclear" instead of inventing it.
- Copy visible text exactly, in quotes.
- Colours: give your best estimate as hex values and say they are estimates. Sizes: use relative terms (small/medium/large) or rough px only when obvious.
- Be compact. No introduction, no closing remarks.

Output exactly these sections in Markdown:
## Overview
One or two sentences: what kind of screen/page this is and its purpose.
## Layout
The structure from top to bottom and left to right (header, sidebar, grid columns, sections), with alignment and rough proportions.
## Components
A list of every distinct element: type (button, input, card, table, tab bar ...), its text, position, and visible state (selected, disabled, error ...).
## Visual style
Colour palette (hex estimates), typography (serif/sans, weights, relative sizes), spacing density, corner radius, shadows, icons, imagery.
## States and behaviour implied
Hover/active/empty/loading/error states that are visible or clearly implied. Mark guesses as "(guess)".
## Accessibility notes
Contrast problems, tiny tap targets, missing labels you can see.
## Open questions
Things the developer must ask the user because the image does not answer them.`;

const READER_PROMPT = "Write the design brief for this image.";

export function isImagePath(p: string): boolean {
  return path.extname(p.trim().replace(/^['"]|['"]$/g, "")).toLowerCase() in MIME;
}

function loadImage(imagePath: string): { abs: string; mime: string; base64: string } {
  const cleaned = imagePath
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\ /g, " ") // a path dragged into the terminal has escaped spaces
    .replace(/^~(?=$|\/)/, process.env.HOME ?? "~");
  const abs = path.resolve(cleaned);
  const mime = MIME[path.extname(abs).toLowerCase()];
  if (!mime) throw new Error(`Unsupported image type. Use ${Object.keys(MIME).join(", ")}.`);
  if (!fs.existsSync(abs)) throw new Error(`Image not found: ${abs}`);
  const size = fs.statSync(abs).size;
  if (size > MAX_IMAGE_BYTES) {
    throw new Error(`Image is ${(size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MB. Export a smaller one.`);
  }
  return { abs, mime, base64: fs.readFileSync(abs).toString("base64") };
}

async function readLocally(model: string, mime: string, base64: string, extra?: string): Promise<string> {
  const client = new OpenAI({
    baseURL: process.env.AI_BASE_URL ?? "http://localhost:1234/v1",
    apiKey: process.env.AI_API_KEY ?? "lm-studio",
    timeout: Number(process.env.AI_TIMEOUT_MS) || 600_000,
  });
  const res = await client.chat.completions.create({
    model,
    temperature: 0.1,
    max_tokens: 3000,
    messages: [
      { role: "system", content: READER_SYSTEM },
      {
        role: "user",
        content: [
          { type: "text", text: extra ? `${READER_PROMPT}\nExtra context from the user: ${extra}` : READER_PROMPT },
          { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
        ],
      },
    ],
  });
  const text = res.choices[0]?.message?.content?.trim();
  if (!text) throw new Error("the vision model returned no text");
  return text;
}

/**
 * Reads the image and returns a design brief, or throws an Error whose message says what to do next.
 * `note` is what the user said about the picture ("make the header sticky"), passed to the reader.
 */
export async function describeImage(imagePath: string, note?: string): Promise<DesignBrief> {
  const img = loadImage(imagePath);
  const visionModel = process.env.AI_VISION_MODEL?.trim();
  const attempts: string[] = [];

  if (visionModel) {
    console.log(pc.dim(`🖼  Reading the image with the local vision model ${visionModel} …`));
    try {
      const brief = await readLocally(visionModel, img.mime, img.base64, note);
      return { imagePath: img.abs, brief, source: `local: ${visionModel}` };
    } catch (err: any) {
      attempts.push(`local model ${visionModel}: ${String(err?.message ?? err).split("\n")[0]}`);
    }
  }

  const gemini = new GeminiTriageClient();
  if (GeminiTriageClient.resolveApiKey()) {
    const answer = await prompts({
      type: "confirm",
      name: "ok",
      message: `Send this image to Google Gemini so it can be described? (${path.basename(img.abs)})`,
      initial: false,
    });
    if (answer.ok) {
      console.log(pc.dim("🖼  Reading the image with Gemini …"));
      try {
        const prompt = note ? `${READER_PROMPT}\nExtra context from the user: ${note}` : READER_PROMPT;
        const out = await gemini.describeImage(READER_SYSTEM, prompt, img.mime, img.base64);
        return { imagePath: img.abs, brief: out.text, source: out.model };
      } catch (err: any) {
        attempts.push(`Gemini: ${String(err?.message ?? err).split("\n")[0]}`);
      }
    } else {
      attempts.push("Gemini: you chose not to send the image");
    }
  }

  const why = attempts.length ? `\n  ${attempts.join("\n  ")}` : "";
  throw new Error(
    "No image reader is available." +
      why +
      "\n  Local option: download a vision model in LM Studio (a Qwen-VL or Gemma vision build), load it, and set AI_VISION_MODEL=<its id> in .env." +
      "\n  Cloud option: set GEMINI_API_KEY in .env and confirm when asked.",
  );
}

/** The text block that is added to a task so every agent builds from the same reference. */
export function renderBriefForAgents(b: DesignBrief): string {
  return (
    `## REFERENCE DESIGN (read from the image ${path.basename(b.imagePath)} by ${b.source})\n` +
    "Build to match this brief. It is an estimate of the picture, so follow the project's existing design system where it conflicts, " +
    "and ask the user about anything listed under Open questions instead of guessing.\n\n" +
    b.brief
  );
}
