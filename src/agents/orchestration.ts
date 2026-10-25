// src/agents/orchestration.ts
//
// Task analysis: which agent a task belongs to, which extra standards that task needs, and whether it is
// big enough to deserve team mode. Everything here is a pure function of the task text (no files, no
// model calls), so it is instant, deterministic and unit-tested (orchestration.test.ts).
//
// Three consumers:
//  - router.ts     uses rankDomains() / pickByKeywords() to route without spending a model call.
//  - executor.ts   uses analyzeTask().knowledge to add TASK-SPECIFIC standards to the system prompt on top of
//                  the standards each agent always carries. This is how the logic standards (decomposition,
//                  edge cases, distributed systems, root cause) reach every agent whose task needs them.
//  - cli / executor print analyzeTask().teamHint when a task crosses several layers.
//
// Keep patterns specific. Generic words ("test", "fix", "page", "button", "component" alone) must not
// route; they fall through to the model router.

// ---------------------------------------------------------------------------
// Routing signals
// ---------------------------------------------------------------------------

export const DOMAIN_KEYWORDS: Record<string, RegExp[]> = {
  qa: [/appium/i, /playwright/i, /selenium/i, /\be2e\b/i, /page object/i, /locator/i, /test automation/i, /xcuitest/i, /espresso/i, /flaky/i, /nunit/i],
  db: [/\bschema\b/i, /migration/i, /\bsql\b/i, /postgres/i, /\bindex(es|ing)?\b/i, /\borm\b/i, /prisma/i, /entity framework/i, /\bquery\b/i],
  api: [/endpoint/i, /\brest(ful)?\b/i, /controller/i, /\bapi\b/i, /middleware/i, /\bdto\b/i, /openapi|swagger/i],
  // Frontend development: styling, UI components, layout, accessibility.
  design: [
    /\bcss\b|\bscss\b|\bsass\b/i,
    /tailwind|shadcn|radix ui|styled-components|css modules?/i,
    /\bui\b/i,
    /\bux\b/i,
    /front-?end/i,
    /layout/i,
    /responsive/i,
    /accessib|\ba11y\b|\bwcag\b|aria-/i,
    /design (system|tokens?)/i,
    /styling|\bstyles?\b.*\b(component|page|button)\b/i,
    /dark mode|light mode|theme toggle/i,
    /landing page|\bnavbar\b|\bsidebar\b|\bmodal\b|\bdropdown\b|\bhero section\b/i,
    /\b(react|vue|svelte|angular|next\.?js) (component|page|form)\b/i,
    /\b(jsx|tsx)\b/i,
    /core web vitals|lighthouse|\bLCP\b|\bCLS\b|layout shift/i,
  ],
  "kb-harvester": [/knowledge base/i, /document (the )?(project|codebase|architecture)/i, /architecture docs?/i, /reverse.?engineer/i],
  // Web research, docs lookup, internet searches.
  research: [
    /search (the )?web/i,
    /look up/i,
    /latest (version|docs|documentation|features|release)/i,
    /check online/i,
    /find on (github|npm|google|internet)/i,
    /web search/i,
    /google this/i,
    /what is new in/i,
    /\bresearch\b/i,
    /release notes?|changelog/i,
    /breaking changes?/i,
    /(official|latest|current) (docs|documentation)/i,
    /\bis (it|this|that) (still )?(deprecated|supported|compatible)/i,
    /compatible with (the )?(latest|newest)/i,
    /which version (of|to use|should)/i,
    // General real-time information (not only documentation): news, weather, prices, scores. Kept specific on purpose.
    /\b(latest|breaking|today'?s|recent) news\b|\bnews (about|on)\b|\bheadlines?\b/i,
    /\bweather (in|for|forecast|today|tomorrow)\b|\bforecast for\b|\bwhat'?s the weather\b|\bwhat is the weather\b/i,
    /\b(exchange rate|stock price|share price|crypto price|price of (bitcoin|gold|oil))\b/i,
    /\bwho (won|is the current)\b|\bfinal score\b|\blive score\b|\bleague standings\b/i,
  ],
  // Failing commands and errors. Several patterns so a real failure report outscores the single keyword
  // it often shares with another agent ("npm run dev:api failing" also matches api).
  debug: [
    /\bfail(s|ed|ing|ure|ures)\b/i,
    /\bcrash(es|ed|ing)?\b/i,
    /exception/i,
    /stack ?trace/i,
    /\b(doesn'?t|does not|won'?t|can'?t|cannot|isn'?t|not)\s+(start|work|working|run|running|build|compile|load|boot)/i,
    /\bbroken\b/i,
    /\bdebug(ging)?\b/i,
    /cannot find module|can'?t resolve dependencies/i,
    /\bE(NOENT|ADDRINUSE|CONNREFUSED|ACCES)\b|\bERR_[A-Z_]+|\bTS\d{4}\b|\bCS\d{4}\b/,
    // A package-manager command together with a failure word, in either order. "npm run" alone is NOT a
    // signal: "add an npm run script" is a normal dev task.
    /\b(npm|pnpm|yarn|bun)\s+(run|start|test|build)\b.*\b(fail|error|crash|broke|not work|won'?t|doesn'?t)|\b(fail|error|crash|broke|won'?t|doesn'?t).*\b(npm|pnpm|yarn|bun)\s+(run|start|test|build)\b/i,
  ],
  logic: [/decompos/i, /trade-?offs?/i, /edge cases?/i, /root cause/i, /\bplan\b.*\b(approach|architecture)\b/i, /distributed/i],
};

/** Verbs that mean "change the project". A research question that also asks for a change is not research-only. */
export const CHANGE_VERB_RE = /\b(add|create|implement|build|write|update|change|modify|fix|refactor|migrate|install|upgrade|rename|remove|delete|generate|scaffold)\b/i;

/**
 * Building a whole application (not one layer of it). Such a task names several technologies, so one keyword
 * domain ("prisma" -> db) would win by accident and hand the whole app to a specialist. It goes to the general
 * `dev` agent instead, with a /team hint. Deliberately narrow: "from scratch" alone is not enough.
 */
export const FULLSTACK_BUILD_RE = /\bfull[- ]?stack\b|\bmonorepo\b|\bscaffold|\bbootstrap\b|\bnew (web )?(app|application|project)\b/i;

export function isFullstackBuild(task: string): boolean {
  return FULLSTACK_BUILD_RE.test(task) && CHANGE_VERB_RE.test(task);
}

/** Domains that build or change code. A task that touches several of them is cross-cutting. */
const BUILD_DOMAINS = ["api", "db", "design", "qa"] as const;

/** Generic test words. In a test-automation project (Appium / Playwright) they mean the QA agent. */
const TEST_WORDS_RE = /\b(tests?|specs?|test suite|scenarios?|test cases?)\b/i;

export interface DomainScore {
  id: string;
  score: number;
}

export interface RankOptions {
  /** The target project is a test-automation project (Appium / Playwright detected). */
  automationProject?: boolean;
}

/** Scores every routing domain for a task, best first. Domains without any signal are left out. */
export function rankDomains(task: string, opts: RankOptions = {}): DomainScore[] {
  const scores: Record<string, number> = {};
  for (const [id, patterns] of Object.entries(DOMAIN_KEYWORDS)) {
    const n = patterns.filter((p) => p.test(task)).length;
    if (n > 0) scores[id] = n;
  }

  // A research question that also asks for a change is a change task with a lookup inside it: the
  // working agent can search the web itself, so it must not be handed to the read-mostly research agent.
  if (scores.research && CHANGE_VERB_RE.test(task)) delete scores.research;

  // Generic test words only mean "QA" in a project that is itself test automation.
  if (opts.automationProject && TEST_WORDS_RE.test(task) && !scores.debug) {
    scores.qa = (scores.qa ?? 0) + 2;
  }

  // Whole-app build: the general dev agent leads, unless the task is really a failure report or a research ask.
  if (isFullstackBuild(task) && !scores.debug && !scores.research && !opts.automationProject) {
    const best = Math.max(0, ...Object.values(scores));
    scores.dev = best + 1;
  }

  return Object.entries(scores)
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

/** The agent id when exactly one domain clearly wins; undefined when it is ambiguous (ties go to the model router). */
export function pickByKeywords(scores: DomainScore[]): string | undefined {
  if (scores.length === 0) return undefined;
  if (scores.length > 1 && scores[0].score === scores[1].score) return undefined;
  return scores[0].id;
}

/** "api(2), db(1)": the signals found, for the model router's prompt and for logs. */
export function describeSignals(scores: DomainScore[]): string {
  return scores.map((s) => `${s.id}(${s.score})`).join(", ");
}

// ---------------------------------------------------------------------------
// Task-specific knowledge
// ---------------------------------------------------------------------------
// Each agent already carries a fixed set of standards (agents/list/*.ts). These rules ADD standards when the
// task text calls for them. Logic standards weigh the most, because they apply to every kind of work.

interface KnowledgeRule {
  id: string;
  test: RegExp | ((task: string) => boolean);
  files: string[];
  /** Higher = loaded first when the task budget cannot hold everything. */
  weight: number;
  /** Agents that never get this rule (they do not write code or already carry the file). */
  skipFor?: string[];
  /** If set, only these agents get the rule. */
  onlyFor?: string[];
}

const NO_CODE_AGENTS = ["kb-harvester", "research"];

/** Agents that build or review application code and therefore get the full-stack building-block standards. */
const FULLSTACK_AGENTS = ["dev", "api", "db", "design", "qa", "logic", "infra"];

const BULLET_LIST_RE = /(?:^|\n)\s*(?:\d+[.)]|[-*•])\s+\S[^\n]*(?:\n\s*(?:\d+[.)]|[-*•])\s+\S[^\n]*){2,}/;

export const KNOWLEDGE_RULES: KnowledgeRule[] = [
  // --- Logic standards ---------------------------------------------------
  {
    id: "edge-cases",
    test: /concurren|race condition|idempoten|double[- ]?(click|submit|charge|spend|booking)|duplicate|\bretr(y|ies)\b|timeout|webhook|time ?zone|\butc\b|daylight|\bdst\b|paginat|transaction|deadlock|\block(s|ing)?\b|optimistic|offline|upload|payment|refund|rate limit|cache invalidation|partial(ly)? fail|out of order|\bcron\b|schedul/i,
    files: ["08-logic/02-edge-case-analysis.md"],
    weight: 5,
    skipFor: NO_CODE_AGENTS,
  },
  {
    id: "decomposition",
    test: (t) =>
      /\b(implement|build|create|design|migrate|refactor|rewrite|integrate|from scratch|end[- ]to[- ]end|workflow|pipeline|onboarding|checkout|lifecycle|state machine|multi[- ]step|several (files|steps|screens))\b/i.test(t) ||
      t.length > 300 ||
      BULLET_LIST_RE.test(t),
    files: ["08-logic/01-problem-decomposition.md"],
    weight: 4,
    skipFor: NO_CODE_AGENTS,
  },
  {
    id: "root-cause",
    test: /root cause|\bwhy (does|is|did|do)\b|intermittent|flaky|sometimes (fails|works|crashes)|regression|only (on|in) (ci|prod|production|release)|works (locally|on my)|heisenbug|random(ly)? fail|since (the )?(update|upgrade|commit|merge)|stopped working/i,
    files: ["08-logic/04-root-cause-debugging.md"],
    weight: 4,
    skipFor: NO_CODE_AGENTS,
  },
  {
    id: "distributed",
    test: /microservice|message broker|kafka|rabbitmq|\bsqs\b|\bsns\b|pub\/?sub|event[- ]driven|event sourcing|\bsaga\b|eventual(ly)? consisten|circuit breaker|service[- ]to[- ]service|\bgrpc\b|\boutbox\b|\bcqrs\b|distributed|\bqueues?\b|background (job|worker)|celery|bullmq|\bworker\b/i,
    files: ["08-logic/03-distributed-systems.md"],
    weight: 4,
    skipFor: NO_CODE_AGENTS,
  },
  {
    id: "failure-playbook",
    test: /\bfail(s|ed|ing|ure)\b|crash|exception|stack ?trace|\bE(NOENT|ADDRINUSE|CONNREFUSED)\b|won'?t (start|build|compile|run)/i,
    files: ["08-logic/05-debugging-playbook.md"],
    weight: 2,
    onlyFor: ["dev", "api", "db", "design", "qa", "logic"],
  },
  // --- Cross-domain standards: a task in one agent's lane that touches another lane --------------
  {
    id: "database",
    test: /migration|\bschema\b|\btable\b|\bcolumn\b|foreign key|\bsql\b|postgres|\borm\b|prisma|typeorm|entity framework|\bseed\b|\brollback\b/i,
    files: ["06-database/02-migration-safety.md", "06-database/04-data-integrity.md"],
    weight: 3,
    skipFor: ["db", ...NO_CODE_AGENTS],
  },
  {
    id: "query-performance",
    test: /slow quer|\bn\+1\b|explain analy|query plan|\bindex(es)?\b|full table scan/i,
    files: ["06-database/03-query-performance.md"],
    weight: 3,
    skipFor: ["db", ...NO_CODE_AGENTS],
  },
  {
    id: "api-contract",
    test: /endpoint|controller|\brest(ful)?\b|\bdto\b|validation|middleware|status code|error response|\bapi\b/i,
    files: ["07-api/03-error-handling.md", "07-api/02-validation-pipes.md"],
    weight: 3,
    skipFor: ["api", ...NO_CODE_AGENTS],
  },
  {
    id: "security",
    test: /\bauth(entication|orization)?\b|\bjwt\b|oauth|password|\btokens?\b|\bsecrets?\b|csrf|\bxss\b|sql injection|\bcors\b|permission|\broles?\b|encrypt|session cookie/i,
    files: ["07-api/04-security-protocols.md"],
    weight: 3,
    skipFor: ["api", ...NO_CODE_AGENTS],
  },
  {
    id: "frontend",
    test: /\bcomponents?\b|\bcss\b|tailwind|\bui\b|responsive|accessib|\ba11y\b|\bforms?\b|layout|\bmodal\b/i,
    files: ["10-design/design-standards.md", "04-frontend/modern-frontend.md"],
    weight: 3,
    onlyFor: ["dev", "api", "logic"],
  },
  {
    id: "appium",
    test: /appium|xcuitest|uiautomator|espresso/i,
    files: ["02-qa-automation/appium-standards.md"],
    weight: 3,
    skipFor: ["qa", ...NO_CODE_AGENTS],
  },
  {
    id: "playwright",
    test: /playwright/i,
    files: ["02-qa-automation/playwright-standards.md"],
    weight: 3,
    skipFor: ["qa", ...NO_CODE_AGENTS],
  },
  // --- Full-stack building blocks (Next.js + NestJS + Neon + R2 + Docker). Matched on the task text because a
  // brand-new project has no marker files for detectStackKnowledge to find yet. ------------------------------
  {
    id: "fullstack-build",
    test: /\bfull[- ]?stack\b|from scratch|\bscaffold|\bbootstrap|\bmonorepo\b|production[- ]ready|\bnew (web )?(app|application|project)\b/i,
    // The roadmap (phases with gates, git, versioning) rides along with the build protocol: one rule, so the protocol stays first.
    files: ["12-fullstack/00-build-protocol.md", "13-delivery/00-roadmap.md"],
    weight: 6,
    onlyFor: FULLSTACK_AGENTS,
  },
  {
    id: "scaffolding",
    test: /\bscaffold|create-next-app|\bnest new\b|@nestjs\/cli|\bmonorepo\b|\bnew (web |full[- ]?stack )?(app|application|project)\b/i,
    files: ["12-fullstack/09-scaffolding.md", "13-delivery/02-versions-2026.md"],
    weight: 6,
    onlyFor: FULLSTACK_AGENTS,
  },
  {
    id: "nextjs",
    test: /\bnext\.?js\b|app router|server actions?|create-next-app|\bnext (app|project|page|route)\b/i,
    files: ["12-fullstack/01-nextjs-app-router.md"],
    weight: 4,
    onlyFor: FULLSTACK_AGENTS,
  },
  {
    id: "nestjs",
    test: /\bnest\.?js\b|@nestjs|\bnest (app|module|controller|service|api)\b/i,
    files: ["12-fullstack/02-nestjs.md"],
    weight: 4,
    onlyFor: FULLSTACK_AGENTS,
  },
  {
    id: "auth-jwt",
    test: /\bjwt\b|json web token|refresh tokens?|access tokens?|\bpassport\b|authentication (system|flow|module)|auth (module|guard|flow)/i,
    files: ["12-fullstack/03-auth-jwt.md"],
    weight: 4,
    onlyFor: FULLSTACK_AGENTS,
  },
  {
    id: "orm",
    test: /\bprisma\b|\bdrizzle\b/i,
    files: ["12-fullstack/04-prisma-drizzle.md"],
    weight: 3,
    onlyFor: FULLSTACK_AGENTS,
  },
  {
    id: "neon",
    test: /\bneon\b|serverless postgres|pooled connection|pgbouncer/i,
    files: ["12-fullstack/05-neon-postgres.md"],
    weight: 3,
    onlyFor: FULLSTACK_AGENTS,
  },
  {
    id: "object-storage",
    test: /\bcloudflare\b|\br2\b|\bs3\b|object storage|presign|\bbuckets?\b/i,
    files: ["12-fullstack/06-cloudflare-r2.md"],
    weight: 3,
    onlyFor: FULLSTACK_AGENTS,
  },
  {
    id: "docker-deploy",
    test: /\bdocker(file)?\b|docker[- ]compose|\bvps\b|\bdeploy(ment|ing)?\b|\bnginx\b|\bcaddy\b|reverse proxy|\bci\/cd\b/i,
    files: ["12-fullstack/07-docker-deploy.md", "13-delivery/04-local-infra-ci.md"],
    weight: 3,
    onlyFor: FULLSTACK_AGENTS,
  },
  {
    id: "ci-testing",
    test: /github actions|\bci\/cd\b|\bci pipeline\b|e2e (suite|tests?)|end-to-end tests?|\bwebserver\b/i,
    files: ["12-fullstack/08-ci-testing.md"],
    weight: 3,
    onlyFor: FULLSTACK_AGENTS,
  },
  // Other stacks: a new project of that kind has no marker files yet, so detectStackKnowledge cannot see it.
  {
    id: "ios-swift",
    test: /\bswiftui\b|\bswift\b|\bxcode\b|\bios (app|application|project)\b|\buikit\b/i,
    files: ["03-mobile/ios-swiftui.md"],
    weight: 4,
    onlyFor: FULLSTACK_AGENTS,
  },
  {
    id: "android-kotlin",
    test: /\bkotlin\b|jetpack compose|\bandroid (app|application|project|studio)\b|\bgradle\b/i,
    files: ["03-mobile/android-compose.md"],
    weight: 4,
    onlyFor: FULLSTACK_AGENTS,
  },
  {
    id: "python-api",
    test: /\bfastapi\b|\buvicorn\b|\bpydantic\b|\bpython (api|backend|service|app)\b/i,
    files: ["05-backend/python-fastapi.md"],
    weight: 4,
    onlyFor: FULLSTACK_AGENTS,
  },
  {
    id: "owasp",
    test: /owasp|security (review|audit|hardening)|penetration|vulnerabilit/i,
    files: ["07-api/05-owasp-checklist.md"],
    weight: 4,
    skipFor: NO_CODE_AGENTS,
  },
  // Interface work: how to use design_search and the project's design-system/MASTER.md.
  {
    id: "design-system",
    test: /design system|landing page|\bdashboard\b|\bfront-?end\b|\bredesign|\bbrand(ing)?\b|look and feel|style guide|\btheme\b|color palette|colou?r scheme|master\.md|\bui\b|\bux\b|\bfull[- ]?stack\b/i,
    files: ["10-design/design-system-workflow.md"],
    weight: 5,
    onlyFor: ["design", "dev"],
  },
  // --- Delivery knowledge (13-delivery): exact, checked recipes and the project lifecycle. -------------------
  {
    id: "delivery-recipe",
    // Specific on purpose: "login" or "session" alone must not pull a Next.js recipe into a mobile task.
    test: /\bprisma\b|\bnext\.?js\b|create-next-app|react-hook-form|\bzod\b|\bnext-auth\b|\bauth\.js\b/i,
    files: ["13-delivery/03-recipe-nextjs-prisma-auth.md"],
    weight: 5,
    onlyFor: FULLSTACK_AGENTS,
  },
  {
    id: "rbac-auth",
    // Accounts with roles and per-user data. "ADMIN ... USER" in capitals is how a spec writes the two roles.
    test: (t) => /\bnext-?auth\b|\bauth\.js\b|\brbac\b|role[- ]based|credentials provider|\bownerFilter\b|\bidor\b|per-user|owner(ship)? (check|filter|column)/i.test(t) || /\bADMIN\b[\s\S]{0,80}\bUSER\b/.test(t),
    files: ["13-delivery/06-recipe-auth-rbac-nextauth.md"],
    weight: 6,
    onlyFor: FULLSTACK_AGENTS,
  },
  {
    id: "ui-pages",
    test: /\bwizard\b|multi-step|login (page|form|screen)|print (view|preview|stylesheet|layout)|pdf preview|admin (page|screen|panel|area)|starter page|\bdetail (view|page)\b/i,
    files: ["13-delivery/07-recipe-ui-pages.md"],
    weight: 6,
    onlyFor: ["design", "dev", "qa"],
  },
  {
    id: "monorepo-db-package",
    // Only when the request names the layout. "monorepo" alone must not load it (the default is one app in apps/web).
    test: /packages\/db\b|packages\/database\b|@app\/db\b|\b(db|database|prisma) package\b/i,
    files: ["13-delivery/08-recipe-monorepo-db-package.md"],
    weight: 6,
    onlyFor: FULLSTACK_AGENTS,
  },
  {
    id: "legal-records",
    test: /\b(agreements?|invoices?|ugovor\w*|legal (document|record)s?|purchase contract|sales? contract|commission contract)\b/i,
    files: ["13-delivery/09-records-and-legal-documents.md"],
    weight: 4,
    onlyFor: ["db", "api", "dev", "design", "qa"],
  },
  {
    id: "git-versioning",
    test: /\bgit\b|\bbranch(es)?\b|\bcommits?\b|\bsemver\b|\bversioning\b|changelog|\brelease (notes|process|tag)\b|version control|git ?flow/i,
    files: ["13-delivery/01-git-versioning.md"],
    weight: 3,
    onlyFor: FULLSTACK_AGENTS,
  },
];

export interface KnowledgePick {
  /** Path relative to src/knowledge. */
  path: string;
  /** The rule that asked for it. */
  rule: string;
  weight: number;
}

/** Hard cap on how many task-specific files one task may add (a small local model has a small context). */
export function maxTaskFiles(): number {
  return Math.max(0, Number(process.env.AGENT_TASK_FILES) || 5);
}

/** The extra standards a task needs, most important first, at most `limit` files. */
export function selectTaskKnowledge(task: string, agentId: string, limit: number = maxTaskFiles()): KnowledgePick[] {
  const picks: KnowledgePick[] = [];
  const seen = new Set<string>();

  const matched = KNOWLEDGE_RULES.filter((rule) => {
    if (rule.skipFor?.includes(agentId)) return false;
    if (rule.onlyFor && !rule.onlyFor.includes(agentId)) return false;
    return typeof rule.test === "function" ? rule.test(task) : rule.test.test(task);
  }).sort((a, b) => b.weight - a.weight);

  for (const rule of matched) {
    for (const file of rule.files) {
      if (seen.has(file)) continue;
      seen.add(file);
      picks.push({ path: file, rule: rule.id, weight: rule.weight });
    }
  }
  return picks.slice(0, limit);
}

/** Every knowledge path the rules can ask for (used by tests to prove none of them points at a missing file). */
export function allRuleKnowledgePaths(): string[] {
  return [...new Set(KNOWLEDGE_RULES.flatMap((r) => r.files))];
}

// ---------------------------------------------------------------------------
// Whole-task analysis
// ---------------------------------------------------------------------------

export interface TaskAnalysis {
  /** Routing signals, best first. */
  scores: DomainScore[];
  /** Build domains (api, db, design, qa) the task touches. */
  domains: string[];
  /** The task crosses several layers: one agent will struggle, team mode fits better. */
  crossCutting: boolean;
  knowledge: KnowledgePick[];
  teamHint?: string;
}

export function analyzeTask(task: string, agentId: string = "dev", opts: RankOptions = {}): TaskAnalysis {
  const scores = rankDomains(task, opts);
  const domains = scores.filter((s) => (BUILD_DOMAINS as readonly string[]).includes(s.id)).map((s) => s.id);
  const building = CHANGE_VERB_RE.test(task) && !scores.some((s) => s.id === "debug" && s.score >= 2);
  const crossCutting = building && (domains.length >= 3 || (domains.length >= 2 && task.length > 240) || isFullstackBuild(task));

  return {
    scores,
    domains,
    crossCutting,
    knowledge: selectTaskKnowledge(task, agentId),
    teamHint: crossCutting
      ? `This task spans ${isFullstackBuild(task) ? "a whole application (frontend + backend + database)" : domains.join(" + ")}. One agent works best on one layer: "/team <task>" (or run --team) lets a Project Manager split it across specialists and a Safety Reviewer check the result.`
      : undefined,
  };
}
