import { describe, it, expect } from "vitest";
import { bus, type AgentEvent } from "../core/events";
import { UsageReportingProvider } from "./usage-provider";
import type { LLMProvider, LLMResponse } from "./types";

function fakeProvider(response: LLMResponse): LLMProvider & { chosen?: string } {
  const p: LLMProvider & { chosen?: string } = {
    name: "fake",
    model: "fake-model",
    nativeTools: false,
    chat: async () => response,
    listModels: async () => ["a", "b"],
    setModel: (id: string) => {
      p.chosen = id;
    },
  };
  return p;
}

function capture(): { events: AgentEvent[]; stop: () => void } {
  const events: AgentEvent[] = [];
  const stop = bus.subscribe((e) => events.push(e));
  return { events, stop };
}

describe("UsageReportingProvider", () => {
  it("returns the inner response unchanged and emits llm_usage from the stats", async () => {
    const response: LLMResponse = {
      content: "hi",
      stats: { ttftMs: 120, totalMs: 2000, outTokens: 50, tokPerSec: 26.5, estimated: false, promptTokens: 900, promptEstimated: false },
    };
    const provider = new UsageReportingProvider(fakeProvider(response));
    const { events, stop } = capture();
    try {
      expect(await provider.chat([{ role: "user", content: "x" }])).toBe(response);
    } finally {
      stop();
    }
    const usage = events.filter((e) => e.type === "llm_usage");
    expect(usage).toHaveLength(1);
    expect(usage[0].payload).toEqual({
      model: "fake-model",
      promptTokens: 900,
      completionTokens: 50,
      promptEstimated: false,
      completionEstimated: false,
      ttftMs: 120,
      totalMs: 2000,
      tokPerSec: 26.5,
    });
  });

  it("marks prompt tokens as estimated when the provider does not report them", async () => {
    const provider = new UsageReportingProvider(
      fakeProvider({ content: "", stats: { ttftMs: 1, totalMs: 2, outTokens: 3, tokPerSec: 0, estimated: true } }),
    );
    const { events, stop } = capture();
    try {
      await provider.chat([]);
    } finally {
      stop();
    }
    const usage = events.find((e) => e.type === "llm_usage");
    expect(usage?.type === "llm_usage" && usage.payload.promptTokens).toBe(0);
    expect(usage?.type === "llm_usage" && usage.payload.promptEstimated).toBe(true);
    expect(usage?.type === "llm_usage" && usage.payload.completionEstimated).toBe(true);
  });

  it("emits nothing when the response has no stats", async () => {
    const provider = new UsageReportingProvider(fakeProvider({ content: "x" }));
    const { events, stop } = capture();
    try {
      await provider.chat([]);
    } finally {
      stop();
    }
    expect(events.filter((e) => e.type === "llm_usage")).toHaveLength(0);
  });

  it("passes the provider properties and model switching through", async () => {
    const inner = fakeProvider({ content: "" });
    const provider = new UsageReportingProvider(inner);
    expect(provider.name).toBe("fake");
    expect(provider.model).toBe("fake-model");
    expect(provider.nativeTools).toBe(false);
    provider.setModel("other");
    expect(inner.chosen).toBe("other");
    expect(await provider.listModels()).toEqual(["a", "b"]);
  });
});
