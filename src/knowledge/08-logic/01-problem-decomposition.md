# src/knowledge/logic-standards/01-problem-decomposition.md
# Problem Decomposition & Execution Planning

## 1. First-Principles Thinking
- Strip away assumptions and framework jargon. What is the core data being moved? What is the core business rule being enforced?
- Never plan a massive, monolithic Pull Request. Break features down into atomic, deployable milestones (e.g., 1. Data Model, 2. Internal API, 3. Business Logic, 4. UI Layer).

## 2. Dependency Graphing
- Before proposing a change, logically map the Blast Radius. 
- Ask: If I change this database schema, which background workers, API routes, and downstream UI components will break? Document these dependencies in your plan.

## 3. State Machine Modeling
- Avoid implicit boolean flags (`is_active`, `is_pending`, `is_shipped`). 
- Map complex business lifecycles (like Orders, Payments, User Onboarding) as explicit Finite State Machines. Define valid transitions (e.g., `PENDING` $\rightarrow$ `PAID` is valid; `SHIPPED` $\rightarrow$ `PENDING` is illegal).