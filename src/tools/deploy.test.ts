import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEPLOY_TEMPLATE_NAMES, checkDeployReadiness, runDeployTemplate, runPredeployCheck } from "./deploy.tool";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

/** The body of a template (what an agent would write to disk). */
function body(name: string): string {
  const text = runDeployTemplate({ name });
  return text.slice(text.indexOf("\n\n") + 2);
}

function put(root: string, rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe("monorepo layout (apps/web, apps/api)", () => {
  it("finds Dockerfiles, .dockerignore and the Next config two levels down", () => {
    const root = tmp();
    put(root, "apps/web/Dockerfile", body("next-dockerfile"));
    put(root, "apps/api/Dockerfile", body("nest-dockerfile"));
    put(root, "apps/web/.dockerignore", body("dockerignore"));
    put(root, "apps/api/.dockerignore", body("dockerignore"));
    put(root, "apps/web/package.json", '{"dependencies":{"next":"16.0.0"}}');
    put(root, "apps/web/next.config.ts", "export default { output: 'standalone' };\n");
    put(root, ".gitignore", "node_modules\n.env\n");
    const results = checkDeployReadiness(root);
    expect(results.find((r) => r.id === "dockerfile")).toBeUndefined();
    expect(results.filter((r) => r.id === "non-root" && r.level === "pass")).toHaveLength(2);
    expect(results.find((r) => r.id === "next-standalone")?.level).toBe("pass");
    expect(results.filter((r) => r.level === "fail")).toEqual([]);
  });

  it("still reports a missing Dockerfile when apps/ has none", () => {
    const root = tmp();
    put(root, "apps/web/package.json", "{}");
    expect(checkDeployReadiness(root).find((r) => r.id === "dockerfile")?.level).toBe("fail");
  });
});

/** A project laid out the way the templates expect, built only from the templates. */
function projectFromTemplates(): string {
  const root = tmp();
  put(root, "web/Dockerfile", body("next-dockerfile"));
  put(root, "api/Dockerfile", body("nest-dockerfile"));
  put(root, "docker-compose.yml", body("compose"));
  put(root, "Caddyfile", body("caddyfile"));
  put(root, ".github/workflows/ci.yml", body("ci-workflow"));
  put(root, "web/.dockerignore", body("dockerignore"));
  put(root, "api/.dockerignore", body("dockerignore"));
  put(root, ".gitignore", "node_modules\n.env\n.env.*\n!.env.example\n");
  put(root, "web/.env.example", "NEXT_PUBLIC_API_URL=\n");
  put(root, "web/package.json", '{"dependencies":{"next":"16.0.0"}}');
  put(root, "web/next.config.ts", "export default { output: 'standalone' };\n");
  return root;
}

describe("deploy_template", () => {
  it("returns every template with a path and notes, and rejects unknown names", () => {
    for (const n of DEPLOY_TEMPLATE_NAMES) {
      const t = runDeployTemplate({ name: n });
      expect(t).toContain("suggested path");
      expect(t).toContain("Notes:");
    }
    expect(runDeployTemplate({ name: "nope" })).toContain("TOOL ERROR");
    expect(body("ci-workflow")).toContain("${{ matrix.dir }}");
  });
});

describe("predeploy_check", () => {
  it("finds no failure in a project built from the templates (they follow their own rules)", () => {
    const results = checkDeployReadiness(projectFromTemplates());
    const failed = results.filter((r) => r.level === "fail");
    expect(failed).toEqual([]);
    expect(results.filter((r) => r.level === "warn")).toEqual([]);
  });

  it("flags root user, missing dockerignore, loose base image and missing healthcheck", () => {
    const root = tmp();
    put(root, "Dockerfile", "FROM node:latest\nCOPY . .\nCMD [\"node\",\"x.js\"]\n");
    const text = runPredeployCheck(root);
    expect(text).toContain("FAIL non-root");
    expect(text).toContain("FAIL dockerignore");
    expect(text).toContain("WARN pinned-base");
    expect(text).toContain("WARN healthcheck");
    expect(text).toContain("NOT verified");
  });

  it("flags a missing Dockerfile and an .env that git would commit", () => {
    const root = tmp();
    put(root, ".gitignore", "node_modules\n");
    const text = runPredeployCheck(root);
    expect(text).toContain("FAIL dockerfile");
    expect(text).toContain("FAIL gitignore-env");
  });

  it("finds literal credentials without printing them", () => {
    const root = projectFromTemplates();
    put(root, "docker-compose.yml", body("compose") + "\n# note\n    environment:\n      POSTGRES_PASSWORD: hunter2hunter2\n      DATABASE_URL: postgres://app:s3cretpass@db:5432/app\n");
    const text = runPredeployCheck(root);
    expect(text).toContain("FAIL secrets");
    expect(text).not.toContain("hunter2hunter2");
    expect(text).not.toContain("s3cretpass");
  });

  it("flags a published database port and a Next Dockerfile without standalone output", () => {
    const root = projectFromTemplates();
    put(root, "docker-compose.yml", body("compose") + "  db:\n    image: postgres:16\n    ports:\n      - \"5432:5432\"\n");
    put(root, "web/next.config.ts", "export default {};\n");
    const text = runPredeployCheck(root);
    expect(text).toContain("FAIL db-port");
    expect(text).toContain("FAIL next-standalone");
  });
});
