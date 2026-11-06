import { describe, it, expect } from "vitest";
import { languageSetting, looksBosnian, pmLanguageNote, wantsBosnian } from "./language";

describe("language", () => {
  it("detects a Bosnian request and ignores English", () => {
    expect(looksBosnian("Napravi aplikaciju za rezervaciju termina, treba prijava korisnika")).toBe(true);
    expect(looksBosnian("Šta radi ovo? molim te popravi grešku")).toBe(true);
    expect(looksBosnian("Create a booking app with login for a barbershop")).toBe(false);
    expect(looksBosnian("Add Šimić to the seed data")).toBe(false);
  });

  it("lets AGENT_LANGUAGE override the detection", () => {
    expect(languageSetting({ AGENT_LANGUAGE: "BS" } as NodeJS.ProcessEnv)).toBe("bs");
    expect(wantsBosnian("Create a booking app", { AGENT_LANGUAGE: "bs" } as NodeJS.ProcessEnv)).toBe(true);
    expect(wantsBosnian("Napravi stranicu za prijavu", { AGENT_LANGUAGE: "en" } as NodeJS.ProcessEnv)).toBe(false);
    expect(languageSetting({} as NodeJS.ProcessEnv)).toBe("auto");
  });

  it("adds the planner note only for Bosnian runs", () => {
    expect(pmLanguageNote("Napravi aplikaciju, treba prijava", {} as NodeJS.ProcessEnv)).toMatch(/Bosnian/);
    expect(pmLanguageNote("Build an app", {} as NodeJS.ProcessEnv)).toBe("");
  });
});
