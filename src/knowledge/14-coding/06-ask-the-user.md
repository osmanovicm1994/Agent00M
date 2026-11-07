# When to Ask the Person and When to Decide

## Ask only when
- the answer exists only in the person's head: a credential, a business rule, a price, a legal text, a choice between two valid designs, which of two conflicting requirements wins;
- an action cannot be undone (dropping data, overwriting uploads, publishing, spending money);
- two honest attempts failed and the cause is outside the project (a missing tool, a stopped service, a wrong Node version).

## Never ask
- what you can read from disk (paths, versions, scripts, existing components, schema);
- something with a sensible default: decide, and write "Assumed: ..." as the first line of your report;
- more than 3 questions at once, or a question that needs more than one word to answer.

## How to ask
1. Do everything that does not depend on the answer first.
2. Use the `ask_user` tool: `question` (one line), `options` (2-4 short answers), `default` (safe and reversible), `why` (what is blocked). One question per call, at most 3 per run. The answer comes back as the tool result: continue with it and repeat the decision in one line. If the tool says nobody can answer (unattended run) or the limit is reached, take the default and write "Assumed: ..." in your report.
3. Only when `ask_user` cannot settle it (several questions at once, or an action that must not run without a person), end your reply with the block:

NEEDS INPUT
1. <one-line question> - options: A) ... B) ... - default: A
WHY: <what is blocked>
CAN CONTINUE WITH: <what you do meanwhile>

4. Keep the options concrete (a value, a file, a library), the default safe and reversible.

## Unattended or auto mode
Nobody may answer. Take the default, say so at the top of the report ("Assumed: ..."), and keep the choice easy to change (one config value or one file). The only exception is an action that cannot be undone: prepare it, describe it, and stop.

## Reading answers
An answer like "A", "yes" or "do the default" applies to the numbered question. Repeat the decision in one line before you continue, so the person can correct it.
