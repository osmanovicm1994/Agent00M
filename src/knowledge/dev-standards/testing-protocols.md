#### 3. `src/knowledge/dev-standards/testing-protocols.md`
```markdown
# Testing & Code Quality Protocols

## 1. Test Isolation & Mocking
- Unit tests must be completely isolated from external infrastructure (no live databases, no network requests). Mock external dependencies using Jest mocks or custom test doubles.
- Integration tests must run against ephemeral, isolated test environments (e.g., test containers or separate test database instances).

## 2. Test Maintainability & Readability
- Follow the Arrange-Act-Assert (AAA) pattern in all test blocks.
- Avoid fragile tests tied to exact text strings or implementation details; assert on behavior, state transitions, and contract responses.

## 3. Error Handling & Resilience
- Never swallow exceptions silently in catch blocks. Log meaningful context with structural metadata and rethrow custom application errors or return explicit error result objects.