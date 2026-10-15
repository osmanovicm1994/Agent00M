// src/core/command-safety.ts
//
// Which shell commands may run without asking. Pure functions, unit-tested (command-safety.test.ts).
// This is a best-effort filter, NOT a sandbox: there is no isolation, so use auto mode only on projects
// under version control.

// Read-only diagnostic commands that need no approval for agents with autoDiagnostics
// (the debug agent). Deliberately strict: no shell metacharacters can match, so nothing can be
// chained or redirected, and only commands that cannot change anything are listed.
const PATH_ARG = "[\\w.\\/@-]+";
export const SAFE_DIAGNOSTIC_RES: RegExp[] = [
  /^(node|npm|npx|pnpm|yarn|bun|deno|python3?|pip3?|dotnet|java|go|rustc|cargo|tsc|git|docker)\s+(-v|--version|version)$/,
  /^git (status|branch|remote -v|stash list)( (-s|-sb|--short|--porcelain|-a|-vv))*$/,
  new RegExp(`^git rev-parse( --[a-z-]+)*( ${PATH_ARG})?$`),
  /^git log( (-n ?\d{1,3}|-\d{1,3}|--oneline|--stat|--name-only|--decorate|--graph))*$/,
  /^git diff( (--stat|--name-only|--staged|--cached|HEAD(~\d+)?))*$/,
  /^pwd$/,
  new RegExp(`^ls( -[alhR]+)?( ${PATH_ARG})?$`),
  /^lsof( -nP)? -i(TCP|UDP)? ?:\d{2,5}( -sTCP:LISTEN)?$/,
  new RegExp(`^which ${PATH_ARG}$`),
  /^uname( -a)?$/,
  new RegExp(`^npm (ls|list)( --depth=\\d)?( ${PATH_ARG})?$`),
  /^npm run$/,
];

export function isSafeDiagnostic(command: string): boolean {
  const c = command.trim().replace(/\s+/g, " ");
  return SAFE_DIAGNOSTIC_RES.some((re) => re.test(c));
}

// Commands that still ask for approval when auto mode is on. They delete or overwrite data,
// rewrite git history, publish, change system state, or pipe a download into a shell. The test is
// unanchored on purpose so a risky part of a chained command (a && rm -rf x) is caught too.
const BOUNDARY = "(^|[\\s;&|(`])";
export const DANGEROUS_COMMAND_RES: RegExp[] = [
  new RegExp(`${BOUNDARY}(sudo|su|rm|rmdir|unlink|shred|dd|mkfs\\w*|chown|kill|pkill|killall|shutdown|reboot|halt)\\b`),
  /\bchmod\b.*\s-\w*R/,
  /\bgit\s+(reset\s+--hard|clean|push|rebase|checkout\s+(--|\.)|restore|stash\s+(drop|clear)|branch\s+-D|filter-branch|update-ref|rm)\b/,
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/,
  /\b(npm|pnpm|yarn)\s+(publish|unpublish|login|adduser)\b/,
  /\b(npm|pnpm)\s+(i|install|add)\b.*\s(-g|--global)\b|\byarn\s+global\b/,
  /\bdocker\s+(system\s+prune|rm|rmi|volume\s+(rm|prune)|compose\s+down\b.*\s-v)/,
  /\b(drop|truncate)\s+(database|table|schema)\b/i,
  /\bprisma\s+(migrate\s+reset|db\s+push\s+--force-reset)\b|\bmigrate:fresh\b|\bdb:drop\b|\bschema:drop\b/,
  /\b(brew|pip3?|gem)\s+(uninstall|remove)\b/,
  />\s*\/dev\/(sd|disk|nvme)|:\(\)\s*\{/,
  // Writing files through the shell skips the write_file gates (read before overwrite, diff, placeholder
  // refusal), so these ask even in auto mode: find -delete, sed -i, tee, truncate, mv, and "> file" /
  // ">> file" redirects (but not 2>&1 or > /dev/null).
  /\bfind\b.*\s-delete\b/,
  new RegExp(`${BOUNDARY}(tee|truncate|mv)\\b|\\b(sed|perl)\\s+(-\\w+\\s+)*-\\w*i`),
  /(^|[^\d&>])>>?\s*(?!\/dev\/null\b|&)[\w.\/~"'$-]/,
];

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND_RES.some((re) => re.test(command));
}

// Paths a command may mention without leaving the project: the null device and the standard streams.
const HARMLESS_ABSOLUTE = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/stdin"]);

/**
 * True when a command mentions a location outside the workspace: an absolute path that is not inside it,
 * `~`, `$HOME`, or a `..` segment. Auto mode asks before running such a command, because the workspace
 * boundary that protects write_file does not apply to the shell. Heuristic: a quoted pattern such as
 * grep "/api" also triggers it (the cost is one extra question, never a skipped one).
 */
export function escapesWorkspace(command: string, workspaceRoot: string): boolean {
  const root = workspaceRoot.replace(/\/+$/, "");
  // URLs (http://localhost:3000/x) are not file paths: drop them before looking for paths.
  const withoutUrls = command.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, " ");
  const tokens = withoutUrls.split(/[\s=,;:|&()<>]+/).map((t) => t.replace(/^["'`]+|["'`]+$/g, ""));
  for (const token of tokens) {
    if (!token) continue;
    if (/^~/.test(token) || /\$\{?HOME\}?/.test(token)) return true;
    if (/(^|\/)\.\.(\/|$)/.test(token)) return true;
    if (token.startsWith("/")) {
      if (HARMLESS_ABSOLUTE.has(token)) continue;
      if (token === root || token.startsWith(root + "/")) continue;
      return true;
    }
  }
  return false;
}
