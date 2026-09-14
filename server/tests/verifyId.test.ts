import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLLMClientOverride } from "../src/llm/index.js";
import { FakeLLMClient, neutralAnalysis } from "./support/fakeLlm.js";
import { runScenario } from "./support/scenario.js";

describe("VERIFY_ID (mocked LLM)", () => {
  let fake: FakeLLMClient;

  beforeEach(() => {
    fake = new FakeLLMClient();
    setLLMClientOverride(fake);
  });

  afterEach(() => {
    setLLMClientOverride(undefined);
  });

  it("verifies in one turn when 3+ fields are given and remembers the intent hint volunteered early", async () => {
    fake.queueExtraction(
      neutralAnalysis({
        pii: { name: "Margaret Chen", dob: "1985-03-15", idLast4: "4472" },
        intentHint: "denied healthcare claim from January",
        caseTypeHint: "healthcare"
      })
    );

    const [step] = await runScenario([
      "I am the policyholder. My name is Margaret Chen. I am calling about my denied healthcare claim from January. DOB is 1985-03-15, SSN last four is 4472."
    ]);

    expect(step.state.identity.verified).toBe(true);
    expect(step.state.identity.matchedFields.sort()).toEqual(["dob", "idLast4", "name"].sort());
    expect(step.result.phase).toBe("RESOLVE_INTENT");
    expect(step.state.memory.intentHint).toBe("denied healthcare claim from January");
    // The reply must never be handed raw claim data even on the success path —
    // the phase handler only talks about verification/memory, not case facts.
    expect(step.result.reply).not.toMatch(/denied|pathology|office note/i);
  });

  it("stays in VERIFY_ID and does not disclose anything when fewer than 3 fields match", async () => {
    fake.queueExtraction(neutralAnalysis({ pii: { name: "Margaret Chen" } }));

    const [step] = await runScenario(["Hi, my name is Margaret Chen and I need help with a claim."]);

    expect(step.state.identity.verified).toBe(false);
    expect(step.result.phase).toBe("VERIFY_ID");
    expect(step.state.identity.matchedFields).toEqual(["name"]);
  });

  it("accumulates fields across turns until verified", async () => {
    fake.queueExtraction(neutralAnalysis({ pii: { name: "Margaret Chen" } }));
    fake.queueExtraction(neutralAnalysis({ pii: { dob: "1985-03-15" } }));
    fake.queueExtraction(neutralAnalysis({ pii: { idLast4: "4472" } }));

    const steps = await runScenario([
      "My name is Margaret Chen.",
      "My date of birth is 1985-03-15.",
      "Last four of my SSN is 4472."
    ]);

    expect(steps[0].state.identity.verified).toBe(false);
    expect(steps[1].state.identity.verified).toBe(false);
    expect(steps[2].state.identity.verified).toBe(true);
    expect(steps[2].result.phase).toBe("RESOLVE_INTENT");
  });

  it("tracks a no-progress streak and offers human transfer after repeated refusal while frustrated", async () => {
    fake.queueExtraction(neutralAnalysis({ pii: { name: "Margaret Chen" } }));
    fake.queueExtraction(neutralAnalysis({ emotion: "frustrated" })); // no new fields
    fake.queueExtraction(neutralAnalysis({ emotion: "angry" })); // still no new fields

    const steps = await runScenario([
      "My name is Margaret Chen.",
      "I already told you who I am. This is ridiculous.",
      "This is a joke. I want a human."
    ]);

    expect(steps[0].state.identity.noProgressStreak).toBe(0);
    expect(steps[1].state.identity.noProgressStreak).toBe(1);
    expect(steps[2].state.identity.noProgressStreak).toBe(2);
    expect(steps[2].state.identity.verified).toBe(false);
    // Verification is never skipped just because the caller is upset.
    expect(steps[2].result.phase).toBe("VERIFY_ID");

    // By the final (2nd no-progress) turn, the phase handler should have been
    // told to lean into offering a human transfer.
    const lastCall = fake.conversationalCalls.at(-1);
    expect(lastCall?.system).toMatch(/transfer/i);
  });

  it("scenario 1.3: exactly 2 matched fields is not enough to verify", async () => {
    fake.queueExtraction(neutralAnalysis({ pii: { name: "Margaret Chen", dob: "1985-03-15" } }));

    const [step] = await runScenario(["My name is Margaret Chen, DOB 1985-03-15."]);

    expect(step.state.identity.matchedFields.sort()).toEqual(["dob", "name"].sort());
    expect(step.state.identity.verified).toBe(false);
    expect(step.result.phase).toBe("VERIFY_ID");
  });

  it("scenario 1.4: a wrong value for one field only counts the fields that actually match", async () => {
    // Caller states a DOB that doesn't match Margaret Chen's real record.
    fake.queueExtraction(
      neutralAnalysis({ pii: { name: "Margaret Chen", dob: "1999-01-01", idLast4: "4472" } })
    );

    const [step] = await runScenario(["Margaret Chen, DOB 1999-01-01, SSN last four 4472."]);

    // Only name + idLast4 actually match the real record; the wrong DOB doesn't count,
    // so this is 2 matched fields, not verified — even though 3 fields were *stated*.
    expect(step.state.identity.matchedFields.sort()).toEqual(["idLast4", "name"].sort());
    expect(step.state.identity.verified).toBe(false);
  });

  it("instructs the model to list ALL still-missing fields every time, not just one or two", async () => {
    fake.queueExtraction(neutralAnalysis({ pii: { name: "Margaret Chen", dob: "1985-03-15" } }));

    await runScenario(["Margaret Chen, DOB 1985-03-15."]);

    const call = fake.conversationalCalls[0];
    expect(call.system).toMatch(/you must mention all of the still-missing options every time/i);
    expect(call.system).toContain("phone number on file, email on file, last 4 digits of your SSN or ID");
  });

  it("the rejected-field branch also requires listing every remaining option, not just one", async () => {
    fake.queueExtraction(neutralAnalysis({ pii: { name: "Margaret Chen", dob: "1999-01-01" } }));

    await runScenario(["Margaret Chen, DOB 1999-01-01."]);

    const call = fake.conversationalCalls[0];
    expect(call.system).toMatch(/mention all of the other still-available options/i);
  });

  it("scenario 1.4 (see DECISIONS.md #12): instructs the model never to stall (\"I'll be right back\") when still unverified", async () => {
    fake.queueExtraction(neutralAnalysis({ pii: { name: "Margaret Chen", dob: "1999-01-01" } }));

    await runScenario(["Margaret Chen, DOB 1999-01-01."]);

    const call = fake.conversationalCalls[0];
    expect(call.system).toMatch(/please hold|give me a moment|i'll be right back/i);
    expect(call.system).toMatch(/directly ask, in this same reply/i);
  });

  it("scenario 1.4 (see DECISIONS.md #29): tells the model to explicitly call out a value stated this turn that didn't match", async () => {
    fake.queueExtraction(neutralAnalysis({ pii: { name: "Margaret Chen", dob: "1999-01-01" } }));

    await runScenario(["Margaret Chen, DOB 1999-01-01."]);

    const call = fake.conversationalCalls[0];
    expect(call.system).toMatch(/date of birth THIS TURN, but it did not match/i);
    expect(call.system).toMatch(/you must say so plainly/i);
  });

  it("does not falsely claim a rejected field when nothing new was stated this turn", async () => {
    fake.queueExtraction(neutralAnalysis({ pii: { name: "Margaret Chen" } }));
    fake.queueExtraction(neutralAnalysis({ emotion: "neutral" })); // no PII this turn

    await runScenario(["My name is Margaret Chen.", "Ok, what else do you need?"]);

    const secondCall = fake.conversationalCalls[1];
    expect(secondCall.system).not.toMatch(/did not match/i);
  });

  it("scenario 1.4 (see DECISIONS.md #30): overrides a hallucinated 'verification complete' claim when still not actually verified", async () => {
    fake.queueExtraction(neutralAnalysis({ pii: { name: "Margaret Chen" } }));
    fake.queueConversation("Thank you! I'll go ahead and complete the verification on my end now. How can I help with your claim?");

    const [step] = await runScenario(["My name is Margaret Chen."]);

    expect(step.state.identity.verified).toBe(false);
    expect(step.result.reply).not.toMatch(/complete the verification/i);
    expect(step.result.reply).toMatch(/doesn't match|share one more of/i);
  });

  it("scenario 1.8 (see DECISIONS.md #30): does NOT override an ordinary, correct answer that merely mentions 'complete the verification' in passing", async () => {
    fake.queueExtraction(neutralAnalysis({ pii: { name: "Margaret Chen" }, inScope: true }));
    fake.queueConversation(
      "Great question — we ask for this to complete the verification process and keep your account secure. Could you share your date of birth or SSN instead?"
    );

    const [step] = await runScenario(["Why do you need my SSN?"]);

    expect(step.state.identity.verified).toBe(false);
    // The real, on-topic answer must survive — not get silently swapped for the generic fallback.
    expect(step.result.reply).toMatch(/keep your account secure/i);
  });

  it("scenario 1.4 (see DECISIONS.md #33): tells the model the real on-file name once a candidate is matched, so it can't address the caller by a different name mentioned incidentally", async () => {
    fake.queueExtraction(neutralAnalysis({ pii: { name: "Margaret Chen" } }));

    await runScenario(["My name is Margaret Chen."]);

    const call = fake.conversationalCalls[0];
    expect(call.system).toMatch(/use only "Margaret Chen"/i);
  });

  it("does not include the real-name grounding instruction before any candidate is matched", async () => {
    fake.queueExtraction(neutralAnalysis());

    await runScenario(["Hi, I need help with something."]);

    const call = fake.conversationalCalls[0];
    expect(call.system).not.toMatch(/use only "/i);
  });

  it("scenario (see DECISIONS.md #34): a closing signal before verification ends the call at DONE instead of continuing to ask for fields", async () => {
    fake.queueExtraction(neutralAnalysis());

    const [step] = await runScenario(["Okay, bye."]);

    expect(step.state.phase).toBe("DONE");
    expect(step.state.identity.verified).toBe(false);
    expect(fake.conversationalCalls).toHaveLength(0); // fixed message, no LLM call needed
  });

  it("does not treat a closing signal as ending the call once already verified (VERIFY_ID wouldn't even run in that case, but guards the flag anyway)", async () => {
    fake.queueExtraction(neutralAnalysis({ pii: { name: "Margaret Chen", dob: "1985-03-15", idLast4: "4472" } }));

    const [step] = await runScenario([
      "I am Margaret Chen, DOB 1985-03-15, SSN last four 4472."
    ]);

    expect(step.state.identity.verified).toBe(true);
    expect(step.result.phase).toBe("RESOLVE_INTENT"); // normal verification path, unaffected
  });

  it("scenario 2.3 (see DECISIONS.md #36): with no intent hint at all, just-verified instructs an open question, never a false 'I'll look into it' implication", async () => {
    fake.queueExtraction(
      neutralAnalysis({ pii: { name: "Margaret Chen", dob: "1985-03-15", idLast4: "4472" } })
    );

    await runScenario(["Margaret Chen, DOB 1985-03-15, SSN last four 4472."]);

    const call = fake.conversationalCalls[0];
    expect(call.system).toMatch(/do not know what they're calling about|you do not yet know what they're calling about/i);
    expect(call.system).toMatch(/open question/i);
    expect(call.system).toMatch(/do not say things like "i'll go ahead and look into it"/i);
  });

  it("with a real intent hint, just-verified still forbids claiming the lookup already happened this reply", async () => {
    fake.queueExtraction(
      neutralAnalysis({
        pii: { name: "Margaret Chen", dob: "1985-03-15", idLast4: "4472" },
        intentHint: "denied healthcare claim from January"
      })
    );

    await runScenario([
      "I'm calling about my denied healthcare claim from January. Margaret Chen, DOB 1985-03-15, SSN last four 4472."
    ]);

    const call = fake.conversationalCalls[0];
    expect(call.system).toMatch(/denied healthcare claim from January/);
    expect(call.system).toMatch(/do not claim you're doing it this reply/i);
  });

  it("scenario 1.7: a direct request for claim details as the very first message (zero identity given) does not verify or disclose", async () => {
    fake.queueExtraction(neutralAnalysis({ inScope: true }));

    const [step] = await runScenario(["Why was my claim denied?"]);

    expect(step.state.identity.matchedFields).toEqual([]);
    expect(step.state.identity.verified).toBe(false);
    expect(step.result.phase).toBe("VERIFY_ID");
  });

  it("scenario 1.8: a clarification question mid-verification doesn't lose already-given fields or crash", async () => {
    fake.queueExtraction(neutralAnalysis({ pii: { name: "Margaret Chen" } }));
    fake.queueExtraction(neutralAnalysis({ inScope: true })); // "why do you need my SSN?" — no new PII stated

    const steps = await runScenario(["My name is Margaret Chen.", "Why do you need my SSN?"]);

    expect(steps[1].state.identity.matchedFields).toEqual(["name"]); // not lost
    expect(steps[1].state.identity.verified).toBe(false);
    expect(steps[1].result.phase).toBe("VERIFY_ID");
  });

  it("scenario 6.4: acknowledges an anxious tone (already worked)", async () => {
    fake.queueExtraction(neutralAnalysis({ pii: { name: "Margaret Chen" }, emotion: "anxious" }));

    await runScenario(["I don't understand why you need all this, is my information safe?"]);

    const call = fake.conversationalCalls[0];
    expect(call.system).toMatch(/acknowledge their feeling/i);
  });

  it("scenario 6.4: acknowledges a confused tone (bug fix — was missing from the trigger list)", async () => {
    fake.queueExtraction(neutralAnalysis({ pii: { name: "Margaret Chen" }, emotion: "confused" }));

    await runScenario(["Wait, I'm confused, what exactly do you need from me?"]);

    const call = fake.conversationalCalls[0];
    expect(call.system).toMatch(/acknowledge their feeling/i);
  });

  it("scenario 6.6: does not include the emotion-acknowledgment instruction once the caller is neutral again", async () => {
    fake.queueExtraction(neutralAnalysis({ pii: { name: "Margaret Chen" }, emotion: "frustrated" }));
    fake.queueExtraction(neutralAnalysis({ pii: { dob: "1985-03-15" }, emotion: "neutral" }));

    await runScenario(["This is ridiculous, my name is Margaret Chen.", "OK, my DOB is 1985-03-15."]);

    const secondCall = fake.conversationalCalls[1];
    expect(secondCall.system).not.toMatch(/acknowledge their feeling/i);
  });

  it("does not re-ask for identity once already verified in an earlier turn", async () => {
    fake.queueExtraction(
      neutralAnalysis({ pii: { name: "Margaret Chen", dob: "1985-03-15", idLast4: "4472" } })
    );
    fake.queueExtraction(neutralAnalysis());

    const steps = await runScenario([
      "Margaret Chen, DOB 1985-03-15, SSN last four 4472.",
      "Can you help me with my claim now?"
    ]);

    expect(steps[0].result.phase).toBe("RESOLVE_INTENT");
    expect(steps[1].result.phase).toBe("RESOLVE_INTENT");
  });
});

describe("out-of-scope guardrail (mocked LLM)", () => {
  let fake: FakeLLMClient;

  beforeEach(() => {
    fake = new FakeLLMClient();
    setLLMClientOverride(fake);
  });

  afterEach(() => {
    setLLMClientOverride(undefined);
  });

  it("redirects politely on the first off-topic turn, then offers escalation on the second consecutive one", async () => {
    fake.queueExtraction(neutralAnalysis({ inScope: false }));
    fake.queueExtraction(neutralAnalysis({ inScope: false }));

    const steps = await runScenario(["What's the capital of France?", "How do airplanes fly?"]);

    expect(steps[0].state.offTopicStreak).toBe(1);
    expect(steps[0].state.escalationOffered).toBe(false);
    expect(steps[0].result.reply).not.toMatch(/transfer/i);

    expect(steps[1].state.offTopicStreak).toBe(2);
    expect(steps[1].state.escalationOffered).toBe(true);
    expect(steps[1].result.reply).toMatch(/transfer/i);
  });

  it("resets the off-topic streak after an in-scope turn", async () => {
    fake.queueExtraction(neutralAnalysis({ inScope: false }));
    fake.queueExtraction(neutralAnalysis({ pii: { name: "Margaret Chen" }, inScope: true }));
    fake.queueExtraction(neutralAnalysis({ inScope: false }));

    const steps = await runScenario(["What's the weather?", "My name is Margaret Chen.", "What's the weather?"]);

    expect(steps[0].state.offTopicStreak).toBe(1);
    expect(steps[1].state.offTopicStreak).toBe(0);
    expect(steps[2].state.offTopicStreak).toBe(1);
  });

  it("does not let an off-topic turn's intent hint overwrite a genuine one captured earlier", async () => {
    fake.queueExtraction(
      neutralAnalysis({ intentHint: "denied healthcare claim from January", inScope: true })
    );
    fake.queueExtraction(neutralAnalysis({ intentHint: "asking how airplanes fly", inScope: false }));

    const steps = await runScenario([
      "I'm calling about my denied healthcare claim from January.",
      "By the way, how do airplanes fly?"
    ]);

    expect(steps[0].state.memory.intentHint).toBe("denied healthcare claim from January");
    expect(steps[1].state.memory.intentHint).toBe("denied healthcare claim from January");
  });
});
