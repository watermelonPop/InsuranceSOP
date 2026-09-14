import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLLMClientOverride } from "../src/llm/index.js";
import { FakeLLMClient, neutralAnalysis } from "./support/fakeLlm.js";
import { runScenario } from "./support/scenario.js";
import { ESCALATION_HANDOFF_MESSAGE, isAffirmativeResponse } from "../src/guardrails/escalation.js";

describe("isAffirmativeResponse", () => {
  it("recognizes common affirmatives", () => {
    for (const msg of ["yes", "Yes please", "sure, go ahead", "transfer me", "connect me now", "okay"]) {
      expect(isAffirmativeResponse(msg)).toBe(true);
    }
  });

  it("recognizes common negatives / non-affirmatives", () => {
    for (const msg of ["no thanks", "let's keep trying", "not yet", "what documents do you need"]) {
      expect(isAffirmativeResponse(msg)).toBe(false);
    }
  });
});

describe("human transfer escalation flow (mocked LLM)", () => {
  let fake: FakeLLMClient;

  beforeEach(() => {
    fake = new FakeLLMClient();
    setLLMClientOverride(fake);
  });

  afterEach(() => {
    setLLMClientOverride(undefined);
  });

  it("moves to a terminal ESCALATED phase when the caller accepts an off-topic escalation offer", async () => {
    fake.queueExtraction(neutralAnalysis({ inScope: false }));
    fake.queueExtraction(neutralAnalysis({ inScope: false }));
    // Third turn ("yes") is intercepted before any extraction call, so no
    // extraction is queued for it.

    const steps = await runScenario(["What's the capital of France?", "How do airplanes fly?", "Yes, transfer me"]);

    expect(steps[1].result.reply).toMatch(/transfer/i);
    expect(steps[1].state.humanTransferOffered).toBe(true);

    expect(steps[2].result.phase).toBe("ESCALATED");
    expect(steps[2].result.reply).toBe(ESCALATION_HANDOFF_MESSAGE);
  });

  it("stays escalated and keeps returning the handoff message on further turns without calling the LLM", async () => {
    fake.queueExtraction(neutralAnalysis({ inScope: false }));
    fake.queueExtraction(neutralAnalysis({ inScope: false }));

    const steps = await runScenario([
      "What's the capital of France?",
      "How do airplanes fly?",
      "Yes, transfer me",
      "Hello? Anyone there?"
    ]);

    expect(steps[3].result.phase).toBe("ESCALATED");
    expect(steps[3].result.reply).toBe(ESCALATION_HANDOFF_MESSAGE);
    expect(fake.conversationalCalls).toHaveLength(0); // never reached a phase handler that calls the LLM conversationally
  });

  it("does not escalate and continues normally if the caller declines the offer", async () => {
    fake.queueExtraction(neutralAnalysis({ inScope: false }));
    fake.queueExtraction(neutralAnalysis({ inScope: false }));
    fake.queueExtraction(neutralAnalysis({ pii: { name: "Margaret Chen" } }));

    const steps = await runScenario([
      "What's the capital of France?",
      "How do airplanes fly?",
      "No, let's keep going — my name is Margaret Chen"
    ]);

    expect(steps[2].result.phase).not.toBe("ESCALATED");
    expect(steps[2].state.identity.matchedFields).toContain("name");
  });
});
