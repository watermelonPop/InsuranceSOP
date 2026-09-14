import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLLMClientOverride } from "../src/llm/index.js";
import { FakeLLMClient, neutralAnalysis } from "./support/fakeLlm.js";
import { runScenario } from "./support/scenario.js";

describe("Representative + consent authorization (mocked LLM, see DECISIONS.md #23)", () => {
  let fake: FakeLLMClient;
  const originalScenario = process.env.CONSENT_SCENARIO;

  beforeEach(() => {
    fake = new FakeLLMClient();
    setLLMClientOverride(fake);
  });

  afterEach(() => {
    setLLMClientOverride(undefined);
    if (originalScenario === undefined) {
      delete process.env.CONSENT_SCENARIO;
    } else {
      process.env.CONSENT_SCENARIO = originalScenario;
    }
  });

  it("asks for the representative's own name once the account holder's fields are matched but no rep name is given yet", async () => {
    fake.queueExtraction(
      neutralAnalysis({
        pii: { name: "Margaret Chen", dob: "1985-03-15", idLast4: "4472" },
        callerRole: "representative"
      })
    );

    const [step] = await runScenario([
      "I'm calling on behalf of my mother. Her name is Margaret Chen, DOB 1985-03-15, SSN last four 4472."
    ]);

    expect(step.state.identity.verified).toBe(false);
    expect(step.state.identity.callerRole).toBe("representative");
    expect(step.state.identity.representativeName).toBeUndefined();
    expect(step.result.phase).toBe("VERIFY_ID");
    const call = fake.conversationalCalls[0];
    expect(call.system).toMatch(/own full name/i);
  });

  it("verifies and authorizes a recognized representative when consent is approved (default scenario)", async () => {
    delete process.env.CONSENT_SCENARIO; // uses the default (quick-approval) scenario
    fake.queueExtraction(
      neutralAnalysis({
        pii: { name: "Margaret Chen", dob: "1985-03-15", idLast4: "4472" },
        callerRole: "representative",
        representativeName: "David Chen"
      })
    );

    const [step] = await runScenario([
      "This is David Chen calling on behalf of my mother Margaret Chen. Her DOB is 1985-03-15, SSN last four 4472."
    ]);

    expect(step.state.identity.verified).toBe(true);
    expect(step.state.identity.representativeAuthorized).toBe(true);
    expect(step.state.identity.partyId).toBe("P9");
    expect(step.result.phase).toBe("RESOLVE_INTENT");
    expect(step.result.reply).not.toMatch(/denied|pathology|office note/i); // still no claim disclosure this turn
  });

  it("denies (without disclosing anything) when the caller isn't a recognized representative for that account", async () => {
    fake.queueExtraction(
      neutralAnalysis({
        pii: { name: "Margaret Chen", dob: "1985-03-15", idLast4: "4472" },
        callerRole: "representative",
        representativeName: "John Smith" // not listed in representatives.json for P9
      })
    );

    const [step] = await runScenario([
      "This is John Smith calling on behalf of Margaret Chen. Her DOB is 1985-03-15, SSN last four 4472."
    ]);

    expect(step.state.identity.verified).toBe(false);
    expect(step.state.humanTransferOffered).toBe(true);
    expect(step.result.phase).toBe("VERIFY_ID");
    const call = fake.conversationalCalls[0];
    expect(call.system).toMatch(/not.*authorized representative/i);
  });

  it("denies (without disclosing anything) when the representative is recognized but consent is not confirmed (timeout scenario)", async () => {
    process.env.CONSENT_SCENARIO = "timeout";
    fake.queueExtraction(
      neutralAnalysis({
        pii: { name: "Margaret Chen", dob: "1985-03-15", idLast4: "4472" },
        callerRole: "representative",
        representativeName: "David Chen"
      })
    );

    const [step] = await runScenario([
      "This is David Chen calling on behalf of my mother Margaret Chen. Her DOB is 1985-03-15, SSN last four 4472."
    ]);

    expect(step.state.identity.verified).toBe(false);
    expect(step.state.humanTransferOffered).toBe(true);
    expect(step.result.phase).toBe("VERIFY_ID");
    const call = fake.conversationalCalls[0];
    expect(call.system).toMatch(/authorization.*could not be confirmed/i);
  });

  it("does not engage the representative gate at all for an ordinary policyholder call (regression)", async () => {
    fake.queueExtraction(
      neutralAnalysis({ pii: { name: "Margaret Chen", dob: "1985-03-15", idLast4: "4472" } })
    );

    const [step] = await runScenario([
      "My name is Margaret Chen, DOB 1985-03-15, SSN last four 4472."
    ]);

    expect(step.state.identity.verified).toBe(true);
    expect(step.state.identity.representativeAuthorized).toBeUndefined();
    expect(step.result.phase).toBe("RESOLVE_INTENT");
  });
});
