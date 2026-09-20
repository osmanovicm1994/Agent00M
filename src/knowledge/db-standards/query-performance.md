#### 3. `src/knowledge/db-standards/query-performance.md`
```markdown
# Advanced Query Performance & Optimization

## 1. Mitigating N+1 Query Anti-Patterns
- Never query database records inside a JavaScript loop (`map`, `forEach`).
- Always fetch related data using optimized Prisma queries with selective payload projection:
  ```typescript
  // CORRECT
  const posts = await prisma.post.findMany({
    include: { author: { select: { id: true, name: true } } }
  });