# Root Cause Analysis & Scientific Debugging

## 1. The scientific method
- Do not guess. Form a hypothesis from the evidence (error text, logs, diff), reproduce the failure, change ONE variable, observe.
- Rank 2-4 hypotheses by likelihood and cost to test; test the cheapest likely one first.
- Non-deterministic failures are almost always shared state, a race, test ordering, time zones, or an external dependency. Reproduce by repetition (run it 10-20 times) before touching code.

## 2. Isolate by halving
- Binary-search the system: if the UI shows wrong data, check the API response; if the API is wrong, check the query; if the query is wrong, check the data.
- For a regression, find the last good state: `git log`, `git diff`, `git bisect`. The cause is usually in what changed last (code, dependency, config, data, environment).
- Do not write fix-code until the exact cause is isolated and you can explain why it produces the symptom.

## 3. Five whys
- Ask why until you reach something you can change: crash, null user id, form validation bypassed, regex failed on one browser, no cross-browser test. Fix the cause (and add the missing test), not only the symptom.

## 4. Fix and prove
- Make the smallest change that removes the cause. No ignore flags, skipped tests, broad try/catch, added sleeps or retries as a "fix".
- Prove it: the originally failing command now passes, a test that failed before the fix passes after it, and nothing adjacent broke.
- If the cause is outside the code (version, env value, running service), report the exact setting or command to change instead of editing code.
