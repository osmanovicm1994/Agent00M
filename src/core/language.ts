// src/core/language.ts
//
// Which language the person reads. AGENT_LANGUAGE=bs forces Bosnian, AGENT_LANGUAGE=en forces English, anything else
// (auto, the default) looks at the request text. Pure functions: no I/O, no model calls.

const BOSNIAN_CHARS_RE = /[čćšžđČĆŠŽĐ]/g;
const BOSNIAN_WORDS_RE =
  /\b(napravi|napraviti|treba|trebam|želim|molim|dodaj|izmijeni|popravi|greška|greške|aplikacij\w*|stranic\w*|korisnik\w*|prijav\w*|ugovor\w*|baz[aeiu] podataka|tabel\w*|lozink\w*|šifr\w*|nemoj|također|ovo|ovaj|moram|hoću|pokreni|provjeri)\b/gi;

export type LanguageSetting = "bs" | "en" | "auto";

export function languageSetting(env: NodeJS.ProcessEnv = process.env): LanguageSetting {
  const v = (env.AGENT_LANGUAGE ?? "").trim().toLowerCase();
  if (v === "bs" || v === "bosnian" || v === "ba") return "bs";
  if (v === "en" || v === "english") return "en";
  return "auto";
}

/** True when the request is written in Bosnian (or Croatian / Serbian): at least 2 typical letters or words. */
export function looksBosnian(text: string): boolean {
  const chars = text.match(BOSNIAN_CHARS_RE)?.length ?? 0;
  const words = text.match(BOSNIAN_WORDS_RE)?.length ?? 0;
  return chars + words >= 2 && words >= 1;
}

/** Whether the person-facing text of this run should be Bosnian. */
export function wantsBosnian(text: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const setting = languageSetting(env);
  if (setting === "bs") return true;
  if (setting === "en") return false;
  return looksBosnian(text);
}

/** Added to the Project Manager's prompt: what is written in Bosnian and what must stay English. Empty for English runs. */
export function pmLanguageNote(text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!wantsBosnian(text, env)) return "";
  return (
    "\n\nLANGUAGE: the person reads Bosnian. Write \"goal\", \"assumptions\", \"risks\" and \"questions\" in Bosnian (latin script, ijekavian). " +
    "Keep everything the engineers and the system read in English: task titles, instructions, acceptance criteria, scope, contract and the quotes in \"coverage\" stay exactly as the request or the rules need them " +
    "(a quote from the request stays in the request's own language)."
  );
}
