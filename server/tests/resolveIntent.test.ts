import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleResolveIntent } from "../src/sop/phases/resolveIntent.js";
import { createInitialState } from "../src/sop/state.js";
import { setLLMClientOverride } from "../src/llm/index.js";
import { FakeLLMClient, neutralAnalysis } from "./support/fakeLlm.js";

describe("RESOLVE_INTENT (mocked LLM)", () => {
  let fake: FakeLLMClient;

  beforeEach(() => {
    fake = new FakeLLMClient();
    setLLMClientOverride(fake);
  });

  afterEach(() => {
    setLLMClientOverride(undefined);
  });

  it("resolves to the single matching claim using remembered hints, without asking the caller from scratch", async () => {
    const state = createInitialState();
    state.identity.verified = true;
    state.identity.partyId = "P9"; // Margaret Chen
    state.memory.intentHint = "denied healthcare claim from January";
    state.memory.caseTypeHint = "healthcare";

    await handleResolveIntent({
      state,
      analysis: neutralAnalysis(),
      userMessage: "Yes please.",
      llm: fake
    });

    expect(state.resolvedCaseId).toBe("CL-2048");
    expect(state.phase).toBe("PROCESS_CASE");
  });

  it("scenario 1.1/spec demo (see DECISIONS.md #38): resolves correctly even when the re-derived intent hint paraphrases 'denied' as 'denial'", async () => {
    fake.conversationalCalls = [];
    fake.queueExtraction(neutralAnalysis());

    const state = createInitialState();
    state.identity.verified = true;
    state.identity.partyId = "P9"; // Margaret Chen — CL-2048 (healthcare, denied) and CL-2011 (healthcare, closed) would tie without the fix
    state.memory.intentHint = "explain denial of healthcare claim from January";
    state.memory.caseTypeHint = "healthcare";

    await handleResolveIntent({
      state,
      analysis: neutralAnalysis(),
      userMessage: "Why was it denied?",
      llm: fake
    });

    expect(state.resolvedCaseId).toBe("CL-2048");
    expect(state.phase).toBe("PROCESS_CASE");
  });

  it("scenario 3.3 (see DECISIONS.md #24): tells PROCESS_CASE to briefly confirm which claim was found before diving into details on first resolution", async () => {
    fake.conversationalCalls = [];
    const state = createInitialState();
    state.identity.verified = true;
    state.identity.partyId = "P12"; // Ma Tian, single claim CL-3001, no hint needed

    await handleResolveIntent({
      state,
      analysis: neutralAnalysis(),
      userMessage: "I need help with a claim.",
      llm: fake
    });

    expect(state.resolvedCaseId).toBe("CL-3001");
    const call = fake.conversationalCalls[0];
    expect(call.system).toMatch(/briefly confirm which claim you found/i);
  });

  it("asks a clarifying question (does not resolve) when the hint is ambiguous between multiple claims", async () => {
    const state = createInitialState();
    state.phase = "RESOLVE_INTENT";
    state.identity.verified = true;
    state.identity.partyId = "P9";
    state.memory.caseTypeHint = "healthcare"; // matches both CL-2048 (denied) and CL-2011 (closed) equally

    await handleResolveIntent({
      state,
      analysis: neutralAnalysis(),
      userMessage: "I need help with my claim.",
      llm: fake
    });

    expect(state.resolvedCaseId).toBeUndefined();
    expect(state.phase).toBe("RESOLVE_INTENT");
  });

  it("resolves immediately when the caller has only one claim on file, even with no hint", async () => {
    const state = createInitialState();
    state.identity.verified = true;
    state.identity.partyId = "P12"; // Ma Tian, single claim CL-3001

    await handleResolveIntent({
      state,
      analysis: neutralAnalysis(),
      userMessage: "I need help with my claim.",
      llm: fake
    });

    expect(state.resolvedCaseId).toBe("CL-3001");
    expect(state.phase).toBe("PROCESS_CASE");
  });

  it("chains straight into PROCESS_CASE on resolution, answering a real question in the same turn instead of wasting it on a generic confirmation (see DECISIONS.md #18)", async () => {
    fake.conversationalCalls = [];
    const state = createInitialState();
    state.identity.verified = true;
    state.identity.partyId = "P9";
    state.memory.intentHint = "denied healthcare claim from January";
    state.memory.caseTypeHint = "healthcare";

    const reply = await handleResolveIntent({
      state,
      analysis: neutralAnalysis(),
      userMessage: "Why was the claim denied?",
      llm: fake
    });

    expect(state.phase).toBe("PROCESS_CASE");
    // The chained call must be PROCESS_CASE's grounded prompt (contains the
    // real denial reason so it CAN answer immediately), not a generic
    // "I'll look into it" confirmation that ignores the actual question.
    const call = fake.conversationalCalls[0];
    expect(call.system).toContain("GROUNDED FACTS FOR THIS CLAIM");
    expect(call.system).toContain("pathology report");
    expect(typeof reply).toBe("string");
  });

  it("scenario 2.3: resolves via case-type hint alone, with no 'denied' wording, to the matching claim of that type", async () => {
    const state = createInitialState();
    state.identity.verified = true;
    state.identity.partyId = "P9";
    state.memory.caseTypeHint = "auto"; // no intentHint at all — Margaret's only auto claim is CL-2102

    await handleResolveIntent({
      state,
      analysis: neutralAnalysis(),
      userMessage: "It's about my auto claim.",
      llm: fake
    });

    expect(state.resolvedCaseId).toBe("CL-2102");
    expect(state.phase).toBe("PROCESS_CASE");
  });

  it("scenario 3.1: with no hint at all and multiple claims, asks a grounded clarifying question listing the caller's real claims", async () => {
    const state = createInitialState();
    state.phase = "RESOLVE_INTENT";
    state.identity.verified = true;
    state.identity.partyId = "P9"; // 4 claims: healthcare(denied), healthcare(closed), dental(closed), auto(open)
    // No memory.intentHint, no memory.caseTypeHint at all.

    await handleResolveIntent({
      state,
      analysis: neutralAnalysis(),
      userMessage: "I need help with a claim.",
      llm: fake
    });

    expect(state.resolvedCaseId).toBeUndefined();
    expect(state.phase).toBe("RESOLVE_INTENT");
    const call = fake.conversationalCalls[0];
    // Grounded: must list her actual claim types, never inventing any other claim.
    expect(call.system).toContain("healthcare");
    expect(call.system).toContain("dental");
    expect(call.system).toContain("auto");
    expect(call.system).toMatch(/never invent/i);
  });

  it("tells a real policyholder with zero claims on file gracefully, without any LLM call needed", async () => {
    const state = createInitialState();
    state.phase = "RESOLVE_INTENT";
    state.identity.verified = true;
    state.identity.partyId = "P7"; // Ava Lopez — a real fixture policyholder with no claims at all

    const reply = await handleResolveIntent({
      state,
      analysis: neutralAnalysis(),
      userMessage: "I need help with a claim.",
      llm: fake
    });

    expect(reply).toMatch(/don't see any claims on file/i);
    expect(state.resolvedCaseId).toBeUndefined();
    // This branch is a hardcoded response, not LLM-generated — no wording-quality
    // risk to verify live, so a mocked test fully proves the behavior on its own.
    expect(fake.conversationalCalls).toHaveLength(0);
  });

  it("scenario (see DECISIONS.md #34): a closing signal in the ambiguous/no-claim-resolved-yet branch ends the call at DONE instead of getting an LLM clarifying question", async () => {
    const state = createInitialState();
    state.phase = "RESOLVE_INTENT";
    state.identity.verified = true;
    state.identity.partyId = "P9"; // Margaret Chen — has multiple claims, would normally be ambiguous

    const reply = await handleResolveIntent({
      state,
      analysis: neutralAnalysis(),
      userMessage: "Okay, bye.",
      llm: fake
    });

    expect(state.phase).toBe("DONE");
    expect(state.resolvedCaseId).toBeUndefined();
    expect(reply).not.toMatch(/don't see any claims/i);
    expect(fake.conversationalCalls).toHaveLength(0);
  });

  it("scenario (see DECISIONS.md #34): a zero-claims caller saying goodbye transitions to DONE instead of looping the same message forever", async () => {
    const state = createInitialState();
    state.phase = "RESOLVE_INTENT";
    state.identity.verified = true;
    state.identity.partyId = "P7"; // Ava Lopez — zero claims on file

    const reply = await handleResolveIntent({
      state,
      analysis: neutralAnalysis(),
      userMessage: "Okay, bye.",
      llm: fake
    });

    expect(state.phase).toBe("DONE");
    expect(reply).not.toMatch(/don't see any claims on file/i);
    expect(fake.conversationalCalls).toHaveLength(0);
  });

  it("scenario (see DECISIONS.md #34): the zero-claims message's human-transfer offer is actually live for the next turn's acceptance check", async () => {
    const state = createInitialState();
    state.phase = "RESOLVE_INTENT";
    state.identity.verified = true;
    state.identity.partyId = "P7";

    await handleResolveIntent({
      state,
      analysis: neutralAnalysis(),
      userMessage: "I need help with a claim.",
      llm: fake
    });

    expect(state.humanTransferOffered).toBe(true);
  });

  it("handles an unverified/missing partyId gracefully instead of crashing", async () => {
    const state = createInitialState(); // partyId is undefined
    const reply = await handleResolveIntent({
      state,
      analysis: neutralAnalysis(),
      userMessage: "Help with my claim",
      llm: fake
    });
    expect(typeof reply).toBe("string");
    expect(reply.length).toBeGreaterThan(0);
  });
});
