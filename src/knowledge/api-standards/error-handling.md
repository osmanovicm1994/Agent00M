#### 3. `src/knowledge/api-standards/error-handling.md`
```markdown
# Error Handling & Exception Management

## 1. Standardized Error Payload Structure
- All error responses across the API must return a uniform JSON shape for predictable client consumption:
  ```json
  {
    "statusCode": 400,
    "error": "Bad Request",
    "message": ["email must be a valid email"],
    "timestamp": "2026-09-20T10:00:00.000Z",
    "path": "/api/v1/users"
  }