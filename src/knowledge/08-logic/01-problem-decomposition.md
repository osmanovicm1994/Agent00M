# Problem Decomposition & Execution Planning

## 1. Start from the goal
- Strip away framework jargon: what data moves, which business rule is enforced, who is affected, what does "done" look like (observable acceptance criteria)?
- Separate what was asked from what is needed. If the request is a mechanism ("add a sleep"), find the real goal first.
- List assumptions and open questions. Ask only when a wrong guess would be expensive; otherwise pick the safe default and say so.

## 2. Split into atomic steps
- Each step leaves the project working and can be verified alone. Order by dependency: data model, internal logic, API, UI, tests.
- No monolithic change. If a step touches more than a few files, split it again.
- After each step run the cheapest check (typecheck, one test) before the next.

## 3. Map the blast radius
- Before changing a schema, a public function or a config, find what depends on it: callers, background workers, API routes, UI components, tests, docs. Write the list in the plan.
- Prefer additive changes (new field, new function) over changing a contract in place; migrate callers, then remove the old one.

## 4. Model lifecycles as states
- Replace piles of boolean flags (`is_active`, `is_pending`, `is_shipped`) with an explicit state enum and a table of allowed transitions (`PENDING -> PAID` valid, `SHIPPED -> PENDING` illegal). Enforce transitions in one place.

## 5. Plan for failure and rollback
- For every step ask how it is undone: a revert, a down migration, a feature flag. Say so for risky steps.
- Decide what the tests must prove before writing code: the happy path, the edge cases that matter, and one failure path.
