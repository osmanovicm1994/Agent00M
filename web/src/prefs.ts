// Small per-device UI preferences kept in localStorage (storage can be blocked, so every access is wrapped).

const IGNORE_KEY = "agent-ui-tree-ignore";

// Same idea as `tree -I 'node_modules|.git'`, plus the agent's own response cache (tens of thousands of hash
// files that would fill the whole listing).
export const DEFAULT_IGNORE_TEXT = "node_modules|.git|.agent_cache";

// "node_modules|.git, dist" -> ["node_modules", ".git", "dist"]. * and ? work inside a name.
export function parseIgnoreText(text: string): string[] {
  return text
    .split(/[|,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadIgnoreText(): string {
  try {
    const saved = localStorage.getItem(IGNORE_KEY);
    return saved && parseIgnoreText(saved).length > 0 ? saved : DEFAULT_IGNORE_TEXT;
  } catch {
    return DEFAULT_IGNORE_TEXT;
  }
}

export function saveIgnoreText(text: string): void {
  try {
    if (parseIgnoreText(text).length === 0 || text === DEFAULT_IGNORE_TEXT) localStorage.removeItem(IGNORE_KEY);
    else localStorage.setItem(IGNORE_KEY, text);
  } catch {
    // ignore: the setting then lasts until reload
  }
}
