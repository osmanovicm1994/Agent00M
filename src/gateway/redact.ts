// src/gateway/redact.ts
//
// Everything that leaves the machine for Gemini passes through here first: the user's query
// (people paste logs, and logs contain tokens) and the workspace overview.
// This is a best-effort filter for well-known secret shapes, not a guarantee.

type Rule = [pattern: RegExp, replacement: string | ((...m: string[]) => string)];

const RULES: Rule[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED_GOOGLE_KEY]"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_KEY]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, (_m, scheme) => `${scheme} [REDACTED]`],
  // scheme://user:password@host
  [/([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, (_m, scheme) => `${scheme}[REDACTED]@`],
  // password=..., "apiKey": "...", client_secret: ...
  [
    /((?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|auth[_-]?token)[\w-]*["']?\s*[:=]\s*["']?)(?!\[REDACTED)([^\s"',;]{4,})/gi,
    (_m, head) => `${head}[REDACTED]`,
  ],
];

export interface Redacted {
  text: string;
  count: number;
}

export function redactSecrets(input: string): Redacted {
  let count = 0;
  let out = input;
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, (...args: any[]) => {
      count++;
      return typeof replacement === "function" ? replacement(...(args as string[])) : replacement;
    });
  }
  return { text: out, count };
}
