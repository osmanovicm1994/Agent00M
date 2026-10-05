# Choosing and tuning a local model (Apple Silicon, 36 GB)

Measure before you trust any number in this file, including these: `npm run bench` prints first-token time and tokens/sec for the model in `.env.local`; `npm run bench:qwen3`, `bench:devstral`, `bench:codestral` do the same for each profile.

## Why speed is what it is

Token generation is memory-bandwidth bound:

    tokens/sec  <=  memory bandwidth / bytes of weights read per token

An M3 Max has 300 GB/s (30-core GPU) or 400 GB/s (40-core GPU). A dense model reads all of its weights for every token. A mixture-of-experts (MoE) model reads only the active experts, which is why a 30B MoE can be several times faster than a 22B dense model.

| Model | Type | Weights (approx.) | Read per token | Ceiling at 300-400 GB/s | Realistic |
| --- | --- | --- | --- | --- | --- |
| Qwen2.5-Coder-32B Q4_K_M (current) | dense | 20 GB | 20 GB | 15-20 tok/s | 10-15 |
| Codestral 22B Q5_K_M | dense | 16 GB | 16 GB | 19-25 tok/s | 14-20 |
| Phi-4 14B Q8_0 | dense | 15.6 GB | 15.6 GB | 19-26 tok/s | 14-22 |
| Devstral Small 24B Q4_K_M | dense | 14 GB | 14 GB | 21-29 tok/s | 15-22 |
| Qwen3-Coder-30B-A3B Q4_K_M | MoE, ~3B active | 18-19 GB | ~2 GB | 100+ tok/s | 40-80 (estimate) |

The "Realistic" column is an estimate (roughly 70% of the ceiling for dense models). Published reports put Qwen3-Coder-30B-A3B at 30-35 tok/s on an M4 Pro (273 GB/s); scale that up for your bandwidth, then run `npm run bench`.

## Recommendation

1. **Qwen3-Coder-30B-A3B-Instruct** (`.env.qwen3coder`, `npm run chat:qwen3`): the daily driver. Fast because it is MoE, native tool calling, long context, ~19 GB so it fits with room for the KV cache.
2. **Devstral Small** (`.env.devstral`): a dense model trained for agent loops with tool calls. Slower, but a reasonable second opinion.
3. **Codestral 22B** (`.env.codestral`): works, but it has **no tool-calling chat template** (confirmed upstream: the Ollama tools request fails with HTTP 400). The agent detects this and uses fenced action blocks instead. Fine for code generation, weaker as an agent driver. The v0.1 weights have a non-production license; check before commercial use.
4. Phi-4 and DeepSeek-Coder-V2-Lite also lack tool templates (fenced mode is automatic) and are not tuned for multi-step agent work.

Model ids differ per download. Run `npm run models` and paste the exact id into the env file. Newer coder models appear regularly; the agent is model-agnostic, so add a rule to `src/llm/models.ts` only if a model needs non-default behavior.

## What the agent does per model (src/llm/models.ts)

- **Native tool calling** (default): `tools` are sent, tool results use the `tool` role.
- **Fenced mode** (Codestral, Phi-4, DeepSeek-Coder, R1): no `tools` payload; the system prompt lists the tools and the ```action / ```write_file block format; the history is flattened to strictly alternating user/assistant text because those chat templates reject the `tool` role.
- **Qwen3 hybrid models**: `/no_think` is added to the system prompt so they do not spend tokens thinking.
- Override with `AI_NATIVE_TOOLS=on|off` and `AI_NO_THINK=on|off`.
- Switch models mid-session with `/model <part of id>` (history is kept), or start with `--model <id>`.

## LM Studio settings that matter

- **Context length**: prompt and output share it. 16k-32k is plenty for this agent; larger costs KV-cache memory and prompt-processing time.
- **GPU offload**: all layers. **Flash attention**: on. **K/V cache quantization** (Q8_0), if your LM Studio version offers it, roughly halves KV memory.
- **Keep the model loaded**: switch off auto-unload so the first request after a pause does not reload 19 GB.
- **MLX vs GGUF**: on Apple Silicon the MLX build is often faster for models that have one. Compare with `npm run bench`, one variant at a time.
- **Speculative decoding** (draft model) can speed up dense models; test it with the benchmark.
- Close memory-hungry apps. The GPU can use only part of the 36 GB.

## Why prompts matter more than you think

Every agent turn re-sends the conversation. The server only skips re-processing the part of the prompt that is byte-identical to the previous request, so the agent keeps the system prompt stable and only appends. For dense models, prompt processing is slow (a 15k-token context can take over a minute), so the dense profiles lower `AGENT_CONTEXT_CHARS` and `AGENT_SKILL_CHARS`. The per-call line `first token Xs · N tok/s` shows which side is slow.

## Notes on the external review that prompted this

- The tok/s figures for dense models (Codestral 35-45, Phi-4 40-50) are above what the memory bandwidth allows; see the table. The MoE option is the one that can actually be that fast.
- MLX runs on the GPU through Metal, not on the Neural Engine.
- `sysctl iogpu.wired_mem_limit` is not the usual key. The commonly documented one is `sudo sysctl iogpu.wired_limit_mb=<MB>` (macOS 14+); check `sysctl iogpu` for what your macOS exposes. It resets at reboot, and modern macOS does not read `/etc/sysctl.conf` by default. A ~19 GB model does not need it.
- "Qwen 2.5 felt mediocre" is plausibly partly the `abliterated` fine-tune (these tend to follow instructions less reliably) on top of a 32B dense model's 10-15 tok/s. Not proven; try a stock model before blaming the family.

## Speed measures in the agent itself

- **Stable prompt prefix**: `compactHistory` now shrinks old tool output in one pass down to ~60% of `AGENT_CONTEXT_CHARS`, instead of trimming a little every turn. Between compactions the history is append-only, so the server reuses its prompt cache.
- **Router**: keyword match first; otherwise one model call capped at 24 tokens, temperature 0. `AGENT_ROUTER=keywords` skips the model call entirely.
- **Fenced-mode stop sequence**: models without a tool template are stopped at `\nTool result (`, so they cannot invent a tool's answer and burn tokens on it.
- **Per-call options**: `chat(messages, tools, { maxTokens, temperature })`. An explicit `maxTokens` disables auto-continuation. The LLM cache key includes the options.
- **`npm run bench`** now also probes the loaded model: native tool calls vs fenced action blocks, with a verdict on `AI_NATIVE_TOOLS`. The name-based profiles in `src/llm/models.ts` are only a guess; the probe is the check.

## Sources

- Ollama issue "codestral doesn't allow tool calling": https://github.com/ollama/ollama/issues/10879
- Local coding LLMs on Apple Silicon (sizes and speeds): https://willitrunai.com/blog/best-local-coding-llms-apple-silicon-24gb
- Coding-agent models on Apple Silicon: https://zachrattner.com/projects/ai-mac-cluster/coding-models
