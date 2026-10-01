# src/knowledge/logic-standards/04-root-cause-debugging.md
# Root Cause Analysis & Scientific Debugging

## 1. The Scientific Method
- **Do not guess.** Formulate a hypothesis based on logs, reproduce the issue consistently, test the hypothesis by changing ONE variable, and observe the result.
- If a bug is non-deterministic (flaky), it is almost always a race condition, uninitialized state, or a timezone/temporal issue.

## 2. Isolating Variables
- Cut the problem in half (Binary Search debugging). If the UI is showing the wrong data, bypass the UI and check the API response. If the API response is wrong, bypass the API and check the database query.
- Never write fix-code until the exact line causing the defect is isolated and understood. 

## 3. The "Five Whys" Protocol
- When a failure occurs, ask "Why" five times to bypass the symptom and hit the systemic flaw.
- *Example:* The system crashed. (Why?) Null pointer exception in billing. (Why?) Payload lacked a user ID. (Why?) Frontend form validation was bypassed. (Why?) The validation regex failed on edge-case browsers. (Why?) We lack automated cross-browser integration tests. $\rightarrow$ *Fix the tests, not just the regex.*