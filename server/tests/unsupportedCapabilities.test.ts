import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLLMClientOverride } from "../src/llm/index.js";
import { handleUserMessage } from "../src/sop/engine.js";
import { createInitialState } from "../src/sop/state.js";
import {
  isRepresentativeEnrollmentRequest,
  REPRESENTATIVE_ENROLLMENT_NOT_SUPPORTED_MESSAGE
} from "../src/guardrails/unsupportedCapabilities.js";
import { FakeLLMClient } from "./support/fakeLlm.js";

describe("isRepresentativeEnrollmentRequest", () => {
  it("recognizes real-world phrasings of trying to enroll a new representative", () => {
    const examples = [
      "I want to consent to a family member as a representative able to call in on my behalf.",
      "Give access to John Smith, my son to all my claims.",
      "Can you add my daughter as a representative on my account?",
      "I'd like to authorize my husband to call in about my claims.",
      "Please grant my brother access to my account."
    ];
    for (const msg of examples) {
      expect(isRepresentativeEnrollmentRequest(msg)).toBe(true);
    }
  });

  it("does not false-positive on unrelated messages, including the real representative-calling-in flow", () => {
    const examples = [
      "Why was my claim denied?",
      "This is David Chen calling on behalf of my mother Margaret Chen. Her DOB is 1985-03-15, SSN last four 4472.",
      "What documents do I need?",
      "Can I access my account online?"
    ];
    for (const msg of examples) {
      expect(isRepresentativeEnrollmentRequest(msg)).toBe(false);
    }
  });
});

describe("engine: representative-enrollment requests are blocked before any LLM call (see DECISIONS.md #28)", () => {
  let fake: FakeLLMClient;

  beforeEach(() => {
    fake = new FakeLLMClient();
    setLLMClientOverride(fake);
  });

  afterEach(() => {
    setLLMClientOverride(undefined);
  });

  it("responds with the fixed not-supported message and offers a human transfer, without calling the LLM", async () => {
    const state = createInitialState();
    state.identity.verified = true;
    state.identity.partyId = "P9";

    const result = await handleUserMessage(state, "Give access to John Smith, my son, to all my claims.");

    expect(result.reply).toBe(REPRESENTATIVE_ENROLLMENT_NOT_SUPPORTED_MESSAGE);
    expect(state.humanTransferOffered).toBe(true);
    expect(fake.conversationalCalls).toHaveLength(0);
  });

  it("lets the caller accept the offered human transfer on the very next turn", async () => {
    const state = createInitialState();
    state.identity.verified = true;
    state.identity.partyId = "P9";

    await handleUserMessage(state, "I want to consent to a family member as a representative.");
    expect(state.humanTransferOffered).toBe(true);

    const result = await handleUserMessage(state, "Yes, please.");
    expect(result.phase).toBe("ESCALATED");
  });
});
