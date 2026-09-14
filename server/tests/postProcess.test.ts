import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handlePostProcess } from "../src/sop/phases/postProcess.js";
import { handleProcessCase } from "../src/sop/phases/processCase.js";
import { createInitialState } from "../src/sop/state.js";
import { setLLMClientOverride } from "../src/llm/index.js";
import { FakeLLMClient, neutralAnalysis } from "./support/fakeLlm.js";

describe("PROCESS_CASE -> POST_PROCESS transition (mocked LLM)", () => {
  let fake: FakeLLMClient;

  beforeEach(() => {
    fake = new FakeLLMClient();
    setLLMClientOverride(fake);
  });

  afterEach(() => {
    setLLMClientOverride(undefined);
  });

  it("mentions the physical (fax/mail) submission alternative for a denied claim with documents needed, even if the caller never explicitly asked (see DECISIONS.md #27)", async () => {
    const state = createInitialState();
    state.phase = "PROCESS_CASE";
    state.identity.verified = true;
    state.identity.partyId = "P9";
    state.resolvedCaseId = "CL-2048"; // denied, documents_needed non-empty

    const reply = await handleProcessCase({
      state,
      analysis: neutralAnalysis(),
      userMessage: "Okay bye",
      llm: fake
    });

    expect(reply).toMatch(/fax|mail/i);
    expect(reply).toMatch(/member portal/i);
  });

  it("falls back to the deterministic recap when the model's enrichment attempt doesn't include the required claim id (see DECISIONS.md #27)", async () => {
    const state = createInitialState();
    state.phase = "PROCESS_CASE";
    state.identity.verified = true;
    state.identity.partyId = "P9";
    state.resolvedCaseId = "CL-2048";
    // FakeLLMClient's default conversational reply ("[mock reply]") doesn't
    // include the case ID — simulates the model dropping/altering a required fact.

    const reply = await handleProcessCase({
      state,
      analysis: neutralAnalysis(),
      userMessage: "No thanks, that's all.",
      llm: fake
    });

    expect(state.phase).toBe("POST_PROCESS");
    expect(state.postProcess.emailOffered).toBe(true);
    expect(state.postProcess.summaryText).toBe(reply);

    // Fell back to the guaranteed-correct deterministic recap.
    expect(reply).toContain("CL-2048");
    expect(reply).toMatch(/denied/i);
    expect(reply).toMatch(/email/i);

    // The enrichment prompt DOES include the required facts (that's the
    // validation anchor) — it's given as pre-approved content to weave in.
    const call = fake.conversationalCalls[0];
    expect(call.system).toContain("PRE-APPROVED FACTS");
    expect(call.system).toContain("CL-2048");
  });

  it("uses the model's enriched recap when it correctly includes every required claim id (see DECISIONS.md #27)", async () => {
    const state = createInitialState();
    state.phase = "PROCESS_CASE";
    state.identity.verified = true;
    state.identity.partyId = "P9";
    state.resolvedCaseId = "CL-2048";

    fake.complete = async (opts) => {
      if (opts.jsonMode) return JSON.stringify(neutralAnalysis());
      return "Thanks for calling! To recap: your healthcare claim CL-2048 was denied over missing paperwork, and you also asked about submitting by mail, which is available. Take care!";
    };

    const reply = await handleProcessCase({
      state,
      analysis: neutralAnalysis(),
      userMessage: "No thanks, that's all.",
      llm: fake
    });

    expect(state.phase).toBe("POST_PROCESS");
    // Enriched reply used verbatim (plus the always-appended email question),
    // including the conversation-specific detail the deterministic template alone couldn't know.
    expect(reply).toContain("you also asked about submitting by mail");
    expect(reply).toMatch(/would you like me to email you a summary/i);
  });

  it("grounds the wrap-up summary in EVERY claim discussed this call, not just the last one (see DECISIONS.md #27)", async () => {
    const state = createInitialState();
    state.phase = "PROCESS_CASE";
    state.identity.verified = true;
    state.identity.partyId = "P9"; // Margaret Chen: CL-2048 (denied), CL-1899 (dental, closed), CL-2011 (healthcare, closed)
    state.resolvedCaseId = "CL-2048";

    // Discuss the denied healthcare claim first.
    await handleProcessCase({ state, analysis: neutralAnalysis(), userMessage: "Why was it denied?", llm: fake });
    expect(state.discussedCaseIds).toEqual(["CL-2048"]);

    // Switch to the dental claim.
    state.memory.caseTypeHint = "dental";
    await handleProcessCase({ state, analysis: neutralAnalysis(), userMessage: "What about my dental claim?", llm: fake });
    expect(state.discussedCaseIds).toEqual(["CL-2048", "CL-1899"]);

    // Switch to the closed healthcare claim (disambiguated directly by case id via memory hint simulation).
    state.resolvedCaseId = "CL-2011";
    state.memory.caseTypeHint = "healthcare";
    await handleProcessCase({ state, analysis: neutralAnalysis(), userMessage: "What about the other healthcare one?", llm: fake });
    expect(state.discussedCaseIds).toEqual(["CL-2048", "CL-1899", "CL-2011"]);

    // Now wrap up — the deterministic recap must cover all 3, not just CL-2011.
    const reply = await handleProcessCase({ state, analysis: neutralAnalysis(), userMessage: "Okay bye", llm: fake });

    expect(reply).toContain("CL-2048");
    expect(reply).toContain("CL-1899");
    expect(reply).toContain("CL-2011");
    expect(reply).toMatch(/denied/i); // CL-2048's outcome
    expect(reply).toMatch(/\$425\.00/); // CL-1899's payout
    expect(reply).toMatch(/\$780\.00/); // CL-2011's payout
  });

  it("guarantees a correct recap and the email question even if the opening-line LLM call fails entirely (see DECISIONS.md #27)", async () => {
    const state = createInitialState();
    state.phase = "PROCESS_CASE";
    state.identity.verified = true;
    state.identity.partyId = "P9";
    state.resolvedCaseId = "CL-2048";

    // Simulate the opening-line call itself failing (e.g. rate limit) —
    // the wrap-up must still produce a correct, complete reply.
    fake.complete = async () => {
      throw new Error("Groq API error 429: rate_limit_exceeded");
    };

    const reply = await handleProcessCase({
      state,
      analysis: neutralAnalysis(),
      userMessage: "okay bye",
      llm: fake
    });

    expect(state.phase).toBe("POST_PROCESS");
    expect(reply).toMatch(/here's a quick recap/i); // hardcoded fallback opening
    expect(reply).toContain("CL-2048");
    expect(reply).toMatch(/email/i);
  });

  it("does not wrap up or check in on an ordinary question well before the turn-count threshold", async () => {
    const state = createInitialState();
    state.phase = "PROCESS_CASE";
    state.identity.verified = true;
    state.identity.partyId = "P9";
    state.resolvedCaseId = "CL-2048";

    await handleProcessCase({ state, analysis: neutralAnalysis(), userMessage: "Why was it denied?", llm: fake });

    expect(state.phase).toBe("PROCESS_CASE");
    expect(state.postProcess.emailOffered).toBe(false);
    expect(state.wrapUpCheckInPending).toBe(false);
  });

  it("asks a soft wrap-up-or-continue check-in after enough turns, rather than force-ending the call", async () => {
    const state = createInitialState();
    state.phase = "PROCESS_CASE";
    state.identity.verified = true;
    state.identity.partyId = "P9";
    state.resolvedCaseId = "CL-2048";

    await handleProcessCase({ state, analysis: neutralAnalysis(), userMessage: "Why was it denied?", llm: fake });
    await handleProcessCase({ state, analysis: neutralAnalysis(), userMessage: "What documents do I need?", llm: fake });
    await handleProcessCase({ state, analysis: neutralAnalysis(), userMessage: "How do I submit them?", llm: fake });
    expect(state.wrapUpCheckInPending).toBe(false); // still under threshold after 3 turns

    const callsBefore = fake.conversationalCalls.length;
    await handleProcessCase({ state, analysis: neutralAnalysis(), userMessage: "What's the appeal deadline?", llm: fake });

    // Still in PROCESS_CASE — the caller has NOT been cut off, only asked a question.
    expect(state.phase).toBe("PROCESS_CASE");
    expect(state.postProcess.emailOffered).toBe(false);
    expect(state.wrapUpCheckInPending).toBe(true);
    const checkInCall = fake.conversationalCalls[callsBefore];
    expect(checkInCall.system).toMatch(/wrap up this call with a summary now, or do you have more questions/i);
  });

  it("wraps up when the caller accepts the check-in", async () => {
    const state = createInitialState();
    state.phase = "PROCESS_CASE";
    state.identity.verified = true;
    state.identity.partyId = "P9";
    state.resolvedCaseId = "CL-2048";
    state.wrapUpCheckInPending = true;

    const reply = await handleProcessCase({ state, analysis: neutralAnalysis(), userMessage: "Yes, wrap it up.", llm: fake });

    expect(state.phase).toBe("POST_PROCESS");
    expect(state.postProcess.emailOffered).toBe(true);
    expect(state.postProcess.summaryText).toBe(reply);
    expect(state.wrapUpCheckInPending).toBe(false);
  });

  it("does NOT wrap up when the caller declines the check-in — resets the window and keeps answering", async () => {
    const state = createInitialState();
    state.phase = "PROCESS_CASE";
    state.identity.verified = true;
    state.identity.partyId = "P9";
    state.resolvedCaseId = "CL-2048";
    state.wrapUpCheckInPending = true;
    state.processCaseTurnCount = 4;

    const reply = await handleProcessCase({
      state,
      analysis: neutralAnalysis(),
      userMessage: "No, I have another question — what's the expected reimbursement?",
      llm: fake
    });

    expect(state.phase).toBe("PROCESS_CASE");
    expect(state.postProcess.emailOffered).toBe(false);
    expect(state.wrapUpCheckInPending).toBe(false);
    expect(state.processCaseTurnCount).toBe(1); // reset to 0, then incremented for this turn's answer
    expect(typeof reply).toBe("string");
    expect(reply.length).toBeGreaterThan(0);
  });

  it("can check in again after the window resets from a decline, if the caller keeps going that long", async () => {
    const state = createInitialState();
    state.phase = "PROCESS_CASE";
    state.identity.verified = true;
    state.identity.partyId = "P9";
    state.resolvedCaseId = "CL-2048";
    state.wrapUpCheckInPending = true;
    state.processCaseTurnCount = 4;

    // Decline the first check-in.
    await handleProcessCase({ state, analysis: neutralAnalysis(), userMessage: "No, more questions please.", llm: fake });
    expect(state.processCaseTurnCount).toBe(1);

    await handleProcessCase({ state, analysis: neutralAnalysis(), userMessage: "What documents do I need?", llm: fake });
    await handleProcessCase({ state, analysis: neutralAnalysis(), userMessage: "How do I submit them?", llm: fake });
    expect(state.wrapUpCheckInPending).toBe(false);

    await handleProcessCase({ state, analysis: neutralAnalysis(), userMessage: "What's the deadline?", llm: fake });
    expect(state.wrapUpCheckInPending).toBe(true); // checked in again after another full window
    expect(state.phase).toBe("PROCESS_CASE"); // still not cut off
  });
});

describe("POST_PROCESS (mocked LLM, no LLM call expected)", () => {
  let fake: FakeLLMClient;

  beforeEach(() => {
    fake = new FakeLLMClient();
    setLLMClientOverride(fake);
  });

  afterEach(() => {
    setLLMClientOverride(undefined);
  });

  it("mock-sends the email and moves to DONE when the caller accepts", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const state = createInitialState();
    state.phase = "POST_PROCESS";
    state.identity.partyId = "P9";
    state.postProcess.emailOffered = true;
    state.postProcess.summaryText = "Summary of the call...";

    const reply = await handlePostProcess({ state, analysis: neutralAnalysis(), userMessage: "Yes please", llm: fake });

    expect(state.postProcess.emailDecision).toBe("sent");
    expect(state.phase).toBe("DONE");
    expect(reply).toMatch(/sent/i);
    expect(consoleSpy).toHaveBeenCalledWith("[MOCK EMAIL] Sending call summary", expect.objectContaining({ partyId: "P9" }));
    consoleSpy.mockRestore();
  });

  it("skips the email and moves to DONE when the caller declines", async () => {
    const state = createInitialState();
    state.phase = "POST_PROCESS";
    state.postProcess.emailOffered = true;

    const reply = await handlePostProcess({ state, analysis: neutralAnalysis(), userMessage: "No, that's okay", llm: fake });

    expect(state.postProcess.emailDecision).toBe("skipped");
    expect(state.phase).toBe("DONE");
    expect(reply).toMatch(/won't send/i);
  });

  it("never calls the LLM for the consent decision itself (deterministic gate)", async () => {
    const state = createInitialState();
    state.phase = "POST_PROCESS";
    state.postProcess.emailOffered = true;

    await handlePostProcess({ state, analysis: neutralAnalysis(), userMessage: "Yes", llm: fake });
    expect(fake.conversationalCalls).toHaveLength(0);
  });
});
