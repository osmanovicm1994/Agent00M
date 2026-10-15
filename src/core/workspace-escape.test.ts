import { describe, expect, it } from "vitest";
import { escapesWorkspace } from "./command-safety";

const ROOT = "/Users/me/projects/app";

describe("escapesWorkspace", () => {
  it.each([
    "npm run build",
    "npx tsc --noEmit",
    "ls src",
    "cat src/index.ts",
    "git status",
    "node scripts/seed.js > /dev/null",
    "npm test 2>&1",
    `ls ${ROOT}/src`,
    `cd ${ROOT} && npm run lint`,
    "curl http://localhost:3000/api/users",
    "dotnet test ./tests/App.Tests",
  ])("stays inside: %s", (cmd) => {
    expect(escapesWorkspace(cmd, ROOT)).toBe(false);
  });

  it.each([
    "cat /etc/passwd",
    "ls ~",
    "cat ~/.ssh/id_rsa",
    "cat $HOME/.zshrc",
    "cat ${HOME}/.zshrc",
    "cat ../other-project/secrets.txt",
    "cd .. && ls",
    "cp src/a.ts /tmp/a.ts",
    "ls /Users/me/projects/app-evil/src",
    "tar -czf /tmp/x.tgz .",
    "npm --prefix=/opt/tool install",
  ])("leaves the project: %s", (cmd) => {
    expect(escapesWorkspace(cmd, ROOT)).toBe(true);
  });

  it("ignores a trailing slash on the root", () => {
    expect(escapesWorkspace(`ls ${ROOT}/src`, ROOT + "/")).toBe(false);
  });
});
