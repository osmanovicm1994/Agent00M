# src/knowledge/api-standards/03-error-handling.md
# Error Handling & Telemetry

## 1. Standardized Error Payloads (RFC 7807)
- Never return raw stack traces or arbitrary error JSON. All 4xx and 5xx errors must conform to a standardized Problem Details format:
```json
{
  "type": "[https://api.example.com/errors/validation-failed](https://api.example.com/errors/validation-failed)",
  "title": "Validation Failed",
  "status": 400,
  "detail": "The request payload contains invalid fields.",
  "instance": "/users/123/profile",
  "errors": [
    { "field": "email", "message": "Must be a valid email address." }
  ]
}