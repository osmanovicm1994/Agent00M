# src/knowledge/logic-standards/03-distributed-systems.md
# Distributed Architecture & Eventual Consistency

## 1. Acknowledging the Fallacies
- The network is not reliable. Latency is not zero. Bandwidth is not infinite.
- Any network call (database, third-party API, internal microservice) MUST have a strict timeout, a retry policy (with exponential backoff and jitter), and a fallback mechanism (Circuit Breaker pattern).

## 2. Managing Distributed Transactions
- Avoid distributed two-phase commits. 
- Use the **Saga Pattern** for cross-service transactions. If Service A succeeds but Service B fails, Service B must trigger a compensation event (rollback) in Service A.

## 3. Eventual Consistency
- When using message brokers (Kafka, RabbitMQ) or async workers (Redis/Celery), accept that read replicas and downstream services will be out of sync for a few milliseconds (or seconds).
- Plan the UI to handle eventual consistency gracefully (e.g., optimistic UI updates, polling, or WebSockets).