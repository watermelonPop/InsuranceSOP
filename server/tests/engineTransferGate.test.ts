import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLLMClientOverride } from "../src/llm/index.js";
import { handleUserMessage } from "../src/sop/engine.js";
import { createInitialState } from "../src/sop/state.js";
import { FakeLLMClient, neutralAnalysis } from "./support/fakeLlm.js";

describe("engine's human-transfer-acceptance gate (see DECISIONS.md #35)", () => {
  let fake: FakeLLMClient;

  beforeEach(() => {
    fake = new FakeLLMClient();
    setLLMClientOverride(fake);
  });

  afterEach(() => {
    setLLMClientOverride(undefined);
  });

  it("a closing signal ('okay, bye') is never misread as accepting a live transfer offer, even though it loosely matches 'okay'", async () => {
    const state = createInitialState();
    state.phase = "RESOLVE_INTENT";
    state.identity.verified = true;
    state.identity.partyId = "P7"; // zero claims on file
    state.humanTransferOffered = true;

    const result = await handleUserMessage(state, "Okay, bye.");

    expect(result.phase).not.toBe("ESCALATED");
    expect(fake.conversationalCalls).toHaveLength(0); // resolved deterministically either way
  });

  it("a genuine affirmative ('yes') still accepts a live transfer offer", async () => {
    const state = createInitialState();
    state.phase = "RESOLVE_INTENT";
    state.identity.verified = true;
    state.identity.partyId = "P7";
    state.humanTransferOffered = true;

    const result = await handleUserMessage(state, "Yes, please.");

    expect(result.phase).toBe("ESCALATED");
  });
});
