import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleProcessCase } from "../src/sop/phases/processCase.js";
import { createInitialState } from "../src/sop/state.js";
import { setLLMClientOverride } from "../src/llm/index.js";
import { FakeLLMClient, neutralAnalysis } from "./support/fakeLlm.js";

describe("PROCESS_CASE (mocked LLM)", () => {
  let fake: FakeLLMClient;

  beforeEach(() => {
    fake = new FakeLLMClient();
    setLLMClientOverride(fake);
  });

  afterEach(() => {
    setLLMClientOverride(undefined);
  });

  it("grounds the prompt in the resolved claim's real denial reason and documents", async () => {
    const state = createInitialState();
    state.identity.verified = true;
    state.identity.partyId = "P9";
    state.resolvedCaseId = "CL-2048";

    await handleProcessCase({ state, analysis: neutralAnalysis(), userMessage: "Why was it denied?", llm: fake });

    const call = fake.conversationalCalls[0];
    expect(call.system).toContain("the review file did not include the pathology report and the treating provider office note");
    expect(call.system).toContain("pathology report");
    expect(call.system).toContain("office note");
    expect(call.system).toContain("CL-2048");
    // Not a fresh resolution/switch this turn — no "briefly confirm" instruction.
    expect(call.system).not.toMatch(/briefly confirm which claim/i);
  });

  it("includes submission/alternative guidance only when documents are actually needed", async () => {
    const state = createInitialState();
    state.identity.verified = true;
    state.identity.partyId = "P9";
    state.resolvedCaseId = "CL-2011"; // closed claim, no documents_needed

    await handleProcessCase({ state, analysis: neutralAnalysis(), userMessage: "What's the status?", llm: fake });

    const call = fake.conversationalCalls[0];
    expect(call.system).not.toContain("Submission guidance");
    expect(call.system).not.toContain("Documents needed");
  });

  it("instructs the model never to invent contact details (email/fax/phone/address)", async () => {
    const state = createInitialState();
    state.identity.verified = true;
    state.identity.partyId = "P9";
    state.resolvedCaseId = "CL-2048";

    await handleProcessCase({
      state,
      analysis: neutralAnalysis(),
      userMessage: "How do I submit the documents?",
      llm: fake
    });

    const call = fake.conversationalCalls[0];
    expect(call.system).toMatch(/never invent a specific email|fax number|mailing address/i);
  });

  it("instructs the model to answer directly rather than stall, since facts are already grounded", async () => {
    const state = createInitialState();
    state.identity.verified = true;
    state.identity.partyId = "P9";
    state.resolvedCaseId = "CL-2048";

    await handleProcessCase({ state, analysis: neutralAnalysis(), userMessage: "Why was it denied?", llm: fake });

    const call = fake.conversationalCalls[0];
    expect(call.system).toMatch(/already looked up|answer directly/i);
  });

  it("scenario 4.2: a standalone 'what documents do I need' question is grounded with the real document list", async () => {
    const state = createInitialState();
    state.identity.verified = true;
    state.identity.partyId = "P9";
    state.resolvedCaseId = "CL-2048";

    await handleProcessCase({
      state,
      analysis: neutralAnalysis(),
      userMessage: "What documents do I need to send in?",
      llm: fake
    });

    const call = fake.conversationalCalls[0];
    expect(call.system).toContain("Documents needed: pathology report, office note");
  });

  it("scenario 4.4: 'I can't get X, what do I do' still surfaces grounded alternative guidance, even though it doesn't hit a specific topic keyword", async () => {
    const state = createInitialState();
    state.identity.verified = true;
    state.identity.partyId = "P9";
    state.resolvedCaseId = "CL-2048";

    await handleProcessCase({
      state,
      analysis: neutralAnalysis(),
      userMessage: "I can't get the pathology report, what do I do?",
      llm: fake
    });

    const call = fake.conversationalCalls[0];
    // The alternative-guidance line is always included per-document regardless
    // of topic classification, so this question is grounded either way.
    expect(call.system).toContain('If "pathology report" isn\'t available:');
    expect(call.system).toContain("hospital, lab, or treating provider");
  });

  it("falls back to RESOLVE_INTENT gracefully if resolvedCaseId is somehow missing", async () => {
    const state = createInitialState();
    state.identity.verified = true;
    state.identity.partyId = "P9";
    // resolvedCaseId intentionally left unset

    const reply = await handleProcessCase({
      state,
      analysis: neutralAnalysis(),
      userMessage: "Why was it denied?",
      llm: fake
    });

    expect(state.phase).toBe("RESOLVE_INTENT");
    expect(typeof reply).toBe("string");
    expect(fake.conversationalCalls).toHaveLength(0); // no LLM call needed for this fail-safe path
  });

  describe("scenario 4.8: claim-switching mid-conversation (see DECISIONS.md #22)", () => {
    it("switches to the caller's other claim when the remembered case-type hint points elsewhere", async () => {
      const state = createInitialState();
      state.identity.verified = true;
      state.identity.partyId = "P9";
      state.resolvedCaseId = "CL-2048"; // currently on the denied healthcare claim
      state.memory.caseTypeHint = "dental"; // engine already merged this from the caller's latest message

      await handleProcessCase({
        state,
        analysis: neutralAnalysis(),
        userMessage: "What about my dental claim instead?",
        llm: fake
      });

      // Margaret has exactly one dental claim (CL-1899) — unambiguous switch.
      expect(state.resolvedCaseId).toBe("CL-1899");
      const call = fake.conversationalCalls[0];
      expect(call.system).toContain("CL-1899");
      expect(call.system).not.toContain("CL-2048");
    });

    it("resets the wrap-up check-in window when switching to a newly-resolved claim", async () => {
      const state = createInitialState();
      state.identity.verified = true;
      state.identity.partyId = "P9";
      state.resolvedCaseId = "CL-2048";
      state.processCaseTurnCount = 3; // one turn away from the check-in
      state.memory.caseTypeHint = "dental";

      await handleProcessCase({
        state,
        analysis: neutralAnalysis(),
        userMessage: "What about my dental claim instead?",
        llm: fake
      });

      // Reset to 0 on switch, then incremented for this turn's answer (same pattern as declining a check-in).
      expect(state.processCaseTurnCount).toBe(1);
    });

    it("asks a clarifying question instead of guessing when the new case type is itself ambiguous", async () => {
      const state = createInitialState();
      state.identity.verified = true;
      state.identity.partyId = "P9";
      state.resolvedCaseId = "CL-1899"; // currently on the dental claim
      state.memory.caseTypeHint = "healthcare"; // Margaret has TWO healthcare claims (CL-2048 denied, CL-2011 closed)

      await handleProcessCase({
        state,
        analysis: neutralAnalysis(),
        userMessage: "Actually, what about my healthcare claim?",
        llm: fake
      });

      expect(state.resolvedCaseId).toBeUndefined();
      expect(state.phase).toBe("RESOLVE_INTENT");
      const call = fake.conversationalCalls[0];
      expect(call.system).toMatch(/never invent/i);
    });

    it("does not switch when the hinted case type matches the currently resolved claim", async () => {
      const state = createInitialState();
      state.identity.verified = true;
      state.identity.partyId = "P9";
      state.resolvedCaseId = "CL-2048";
      state.memory.caseTypeHint = "healthcare"; // same type as the currently resolved claim

      await handleProcessCase({
        state,
        analysis: neutralAnalysis(),
        userMessage: "Why was it denied?",
        llm: fake
      });

      expect(state.resolvedCaseId).toBe("CL-2048");
    });

    it("does not switch (proceeds unchanged) when the caller doesn't actually have a claim of the hinted type", async () => {
      const state = createInitialState();
      state.identity.verified = true;
      state.identity.partyId = "P12"; // Ma Tian — only ever has one healthcare claim, CL-3001
      state.resolvedCaseId = "CL-3001";
      state.memory.caseTypeHint = "auto"; // he has no auto claim at all

      const reply = await handleProcessCase({
        state,
        analysis: neutralAnalysis(),
        userMessage: "What about my auto claim?",
        llm: fake
      });

      // matchingType is empty for this caller — proceeds unchanged rather than crashing or losing the resolved claim.
      expect(state.resolvedCaseId).toBe("CL-3001");
      expect(typeof reply).toBe("string");
    });
  });

  it("falls back gracefully if the resolved case id doesn't exist in claims data", async () => {
    const state = createInitialState();
    state.identity.verified = true;
    state.identity.partyId = "P9";
    state.resolvedCaseId = "CL-does-not-exist";

    const reply = await handleProcessCase({
      state,
      analysis: neutralAnalysis(),
      userMessage: "Why was it denied?",
      llm: fake
    });

    expect(reply).toMatch(/human representative/i);
    expect(fake.conversationalCalls).toHaveLength(0);
  });
});
