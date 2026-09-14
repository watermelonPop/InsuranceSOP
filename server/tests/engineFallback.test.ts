import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLLMClientOverride } from "../src/llm/index.js";
import { handleUserMessage } from "../src/sop/engine.js";
import { createInitialState } from "../src/sop/state.js";
import { FakeLLMClient, neutralAnalysis } from "./support/fakeLlm.js";

describe("engine graceful degradation when a phase handler's LLM call fails", () => {
  let fake: FakeLLMClient;

  beforeEach(() => {
    fake = new FakeLLMClient();
    setLLMClientOverride(fake);
  });

  afterEach(() => {
    setLLMClientOverride(undefined);
  });

  it("returns an in-character fallback reply instead of throwing, and offers a human transfer", async () => {
    fake.queueExtraction(neutralAnalysis({ pii: { name: "Margaret Chen" } }));
    // Make the phase handler's conversational call fail (simulates a
    // provider outage / exhausted quota, as happened in production — see
    // DECISIONS.md #19).
    const originalComplete = fake.complete.bind(fake);
    let callCount = 0;
    fake.complete = async (opts) => {
      callCount += 1;
      if (callCount === 1) return originalComplete(opts); // the extraction call succeeds
      throw new Error("Groq API error 429: rate_limit_exceeded");
    };

    const state = createInitialState();
    const result = await handleUserMessage(state, "My name is Margaret Chen.");

    expect(result.reply).toMatch(/trouble connecting|try again/i);
    expect(state.humanTransferOffered).toBe(true);
    // The turn is still recorded in history despite the failure, so context isn't silently lost.
    expect(state.historyForLLM.at(-1)).toEqual({ role: "assistant", content: result.reply });
  });

  it("lets the caller accept the offered transfer on the very next turn", async () => {
    fake.queueExtraction(neutralAnalysis());
    let shouldFail = true;
    fake.complete = async (opts) => {
      if (opts.jsonMode) return JSON.stringify(neutralAnalysis());
      if (shouldFail) {
        shouldFail = false;
        throw new Error("Groq API error 429: rate_limit_exceeded");
      }
      return "[mock reply]";
    };

    const state = createInitialState();
    await handleUserMessage(state, "Hello");
    expect(state.humanTransferOffered).toBe(true);

    const result = await handleUserMessage(state, "Yes, transfer me");
    expect(result.phase).toBe("ESCALATED");
  });
});
