// src/orchestra/env-int.ts
//
// Reads a whole-number setting from the environment. `Number(x) || fallback` accepts negatives and fractions
// ("-5", "2.5") and silently turns "0" into the fallback; this helper accepts only integers inside [min, max] and
// uses the fallback for everything else (unset, empty, text, out of range).

export function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
