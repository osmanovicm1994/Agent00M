# src/knowledge/logic-standards/02-edge-case-analysis.md
# Edge Cases & Resilience

## 1. Concurrency & Race Conditions
- Assume two identical requests will hit your system at the exact same millisecond. 
- Ask: Will this result in double-charging a user? Will this duplicate a database record? Plan for database constraints (Unique Indexes) and idempotency keys to prevent race conditions.

## 2. The "Partial Failure" Scenario
- Assume the network will fail precisely halfway through your logic.
- Ask: If the payment succeeds but the database update times out, what state is the system in? 
- Design compensations: Use database transactions for local state, and Idempotency/Webhook reconciliations for third-party integrations.

## 3. Temporal & Spatial Edge Cases
- **Timezones:** Always store time in UTC. Apply timezone offsets only at the final presentation layer. Consider daylight saving time boundary crossings in scheduled jobs.
- **Pagination Exhaustion:** Assume the user has 10,000 records, not 10. Plan how the UI and API will handle massive payloads without freezing.