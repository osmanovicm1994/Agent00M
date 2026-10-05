// Per-model behavior profiles.
//
// Local models differ in ways that matter to an agent loop:
//  - Some chat templates have NO tool-calling support. Sending a `tools` array
//    to them either errors (HTTP 400) or makes the model ignore the schema.
//    For those we send no `tools` at all and rely on the fenced-block protocol
//    the executor already understands (```action / ```write_file blocks).
//  - Qwen3 "hybrid" models think by default; "/no_think" switches that off.
//  - Reasoning models spend hundreds of tokens before the first useful one.
//
// The first matching entry wins. Anything unmatched gets DEFAULT_PROFILE
// (native tool calling), which suits modern instruct/coder models such as
// Qwen3-Coder and Devstral. Override per run with AI_NATIVE_TOOLS=on|off.

export interface ModelProfile {
  // true: send OpenAI-style `tools` and read native tool_calls.
  // false: send no `tools`; the model must use fenced action blocks.
  nativeTools: boolean;
  temperature: number;
  // Append "/no_think" to the system prompt (Qwen3 hybrid thinking models).
  noThink?: boolean;
  note: string;
}

interface ProfileRule {
  match: RegExp;
  profile: ModelProfile;
}

const RULES: ProfileRule[] = [
  {
    match: /deepseek-r1|-r1-|\br1\b/i,
    profile: {
      nativeTools: false,
      temperature: 0.6,
      note: "reasoning model: long <think> phase before the first useful token (slow to answer)",
    },
  },
  {
    match: /codestral/i,
    profile: {
      nativeTools: false,
      temperature: 0.2,
      note: "Codestral 22B has no tool-calling chat template; uses fenced action blocks",
    },
  },
  {
    match: /phi-?4(?!.*mini)/i,
    profile: {
      nativeTools: false,
      temperature: 0.2,
      note: "Phi-4 (14B) has no tool-calling template; uses fenced action blocks",
    },
  },
  {
    match: /deepseek-coder/i,
    profile: {
      nativeTools: false,
      temperature: 0.2,
      note: "DeepSeek-Coder GGUF templates usually lack tools; uses fenced action blocks",
    },
  },
  {
    // Qwen3 hybrid models only. Coder / Instruct-2507 / Thinking variants are excluded.
    match: /qwen3(?!.*(coder|instruct|thinking|2507))/i,
    profile: {
      nativeTools: true,
      temperature: 0.2,
      noThink: true,
      note: "Qwen3 hybrid model: /no_think is added so it does not burn tokens on thinking",
    },
  },
];

export const DEFAULT_PROFILE: ModelProfile = {
  nativeTools: true,
  temperature: 0.2,
  note: "native tool calling",
};

export function getProfile(modelId: string): ModelProfile {
  for (const rule of RULES) {
    if (rule.match.test(modelId)) return rule.profile;
  }
  return DEFAULT_PROFILE;
}

// AI_NATIVE_TOOLS=on|off overrides the profile (useful when a model's template
// turns out to behave differently from what the table assumes).
export function resolveNativeTools(profile: ModelProfile): boolean {
  const v = (process.env.AI_NATIVE_TOOLS ?? "").trim().toLowerCase();
  if (["on", "1", "true", "yes"].includes(v)) return true;
  if (["off", "0", "false", "no"].includes(v)) return false;
  return profile.nativeTools;
}

export function resolveNoThink(profile: ModelProfile): boolean {
  const v = (process.env.AI_NO_THINK ?? "").trim().toLowerCase();
  if (["on", "1", "true", "yes"].includes(v)) return true;
  if (["off", "0", "false", "no"].includes(v)) return false;
  return Boolean(profile.noThink);
}
