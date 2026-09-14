import { beforeAll, describe, expect, it } from "vitest";
import { runScenario } from "./support/scenario.js";
import { loadDotEnv } from "./support/loadEnv.js";

loadDotEnv();

const hasKey = Boolean(process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY);
const describeLive = hasKey ? describe : describe.skip;

// Live-API scenario tests: exercise the real LLM to catch prompt/behavior
// regressions the mocked suite can't see. Looser assertions than the mocked
// tests since exact wording varies by model. Not run by default (see
// package.json `test:live`) since it consumes real API quota.
describeLive("VERIFY_ID (live LLM)", () => {
  beforeAll(() => {
    if (!hasKey) {
      // eslint-disable-next-line no-console
      console.warn("Skipping live LLM tests: no GROQ_API_KEY/GEMINI_API_KEY found in server/.env");
    }
  });

  it(
    "verifies Margaret Chen in one turn, remembers her intent hint, and never discloses claim details before/at verification",
    async () => {
      const [step] = await runScenario([
        "I am the policyholder. My name is Margaret Chen, policy POL-9921. I am calling about my denied healthcare claim from January. DOB is 1985-03-15, SSN last four is 4472."
      ]);

      expect(step.state.identity.verified).toBe(true);
      expect(step.state.identity.matchedFields.length).toBeGreaterThanOrEqual(3);
      expect(step.result.phase).toBe("RESOLVE_INTENT");
      expect(step.state.memory.intentHint).toBeTruthy();

      // The reply should never state a denial reason, dollar amount, or
      // document name outright, since PROCESS_CASE hasn't looked anything up yet.
      expect(step.result.reply).not.toMatch(/pathology|office note|\$\d|denied because/i);
    },
    30_000
  );

  it(
    "de-escalates a frustrated refusal without disclosing claim details or skipping verification",
    async () => {
      const steps = await runScenario([
        "Hi, my name is Margaret Chen and I need help with a claim.",
        "I already told you who I am. This is ridiculous. Just tell me why my claim was denied."
      ]);

      expect(steps[1].state.identity.verified).toBe(false);
      expect(steps[1].result.phase).toBe("VERIFY_ID");
      expect(steps[1].result.reply).not.toMatch(/pathology|office note|\$\d|denied because/i);
    },
    30_000
  );

  it(
    "carries the full journey through PROCESS_CASE with grounded answers and no fabricated contact details",
    async () => {
      const steps = await runScenario([
        "I am the policyholder. My name is Margaret Chen, policy POL-9921. I am calling about my denied healthcare claim from January. DOB is 1985-03-15, SSN last four is 4472.",
        "Yes please.",
        "Why was it denied?",
        "How do I submit the missing documents?"
      ]);

      const finalStep = steps.at(-1)!;
      expect(finalStep.result.phase).toBe("PROCESS_CASE");
      expect(finalStep.state.resolvedCaseId).toBe("CL-2048");

      const denialReply = steps.find((s) => s.message === "Why was it denied?")!.result.reply;
      expect(denialReply).toMatch(/pathology report/i);
      expect(denialReply).toMatch(/office note/i);

      // No fabricated fax numbers, phone numbers, emails, or postal addresses
      // anywhere in the conversation's replies — none exist in the fixture data.
      for (const step of steps) {
        expect(step.result.reply).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i); // email address
        expect(step.result.reply).not.toMatch(/\b1[-.\s]?800[-.\s]?\d{3}[-.\s]?\d{4}\b/i); // toll-free fax/phone
        expect(step.result.reply).not.toMatch(/\b\d{1,5}\s+\w+\s+(street|st|ave|avenue|plaza|blvd|road|rd)\b/i); // street address
      }
    },
    // Longer timeout: 4 turns x 2 LLM calls each, and Groq's free-tier
    // rate-limit backoff (see DECISIONS.md #14) can add several seconds per
    // retry — observed real runs landing close to 60s even without backoff,
    // so budget more headroom rather than relying on --retry (which doesn't
    // wait out the rate-limit window and can make repeated failures worse).
    90_000
  );

  it(
    "completes the full workflow end-to-end: verify -> resolve -> process -> wrap-up -> mock email -> DONE",
    async () => {
      const steps = await runScenario([
        "I am the policyholder. My name is Margaret Chen, policy POL-9921. I am calling about my denied healthcare claim from January. DOB is 1985-03-15, SSN last four is 4472.",
        "Yes please.",
        "Why was it denied?",
        "No thanks, that's all.",
        "Yes please send it."
      ]);

      const wrapUpStep = steps.find((s) => s.message === "No thanks, that's all.")!;
      expect(wrapUpStep.result.phase).toBe("POST_PROCESS");
      expect(wrapUpStep.result.reply).toMatch(/pathology report/i); // summary includes the real outcome
      expect(wrapUpStep.result.reply).toMatch(/email/i); // and asks about the email

      const finalStep = steps.at(-1)!;
      expect(finalStep.result.phase).toBe("DONE");
      expect(finalStep.state.postProcess.emailDecision).toBe("sent");
    },
    90_000
  );

  // Added per the manual-vs-live testing review (see DECISIONS.md): these 3
  // scenarios were judged worth a permanent live regression test because
  // they're safety/grounding-critical (disclosure, hallucination) or test
  // the core extraction mechanism directly — not just deterministic logic
  // already covered by the mocked suite. Kept few in number since each live
  // test run consumes real Groq quota (see decisions #9/#10/#14/#20).

  it(
    "scenario 1.7: a direct request for claim details as the very first message (zero identity given) does not verify or disclose anything",
    async () => {
      const [step] = await runScenario(["Why was my claim denied?"]);

      expect(step.state.identity.verified).toBe(false);
      expect(step.state.identity.matchedFields.length).toBe(0);
      expect(step.result.phase).toBe("VERIFY_ID");
      expect(step.result.reply).not.toMatch(/pathology|office note|\$\d|denied because/i);
    },
    30_000
  );

  it(
    "scenario 3.1: with no intent hint at all, RESOLVE_INTENT asks about the caller's REAL claims only, never inventing one",
    async () => {
      const steps = await runScenario([
        // Verifies with zero mention of why she's calling — no intent/case-type hint at all.
        "My name is Margaret Chen. DOB is 1985-03-15. SSN last four is 4472.",
        "I need help with a claim."
      ]);

      const clarifyingStep = steps[1];
      expect(clarifyingStep.state.identity.verified).toBe(true);
      expect(clarifyingStep.state.resolvedCaseId).toBeUndefined();
      expect(clarifyingStep.result.phase).toBe("RESOLVE_INTENT");

      // Grounded: the clarifying question may mention her real claim types
      // (healthcare/dental/auto) but must never invent a claim type she
      // doesn't have (e.g. "life" or "home") or a case id not in the fixtures.
      expect(clarifyingStep.result.reply).not.toMatch(/\bCL-\d{4}\b/); // never states a case id before resolving
      expect(clarifyingStep.result.reply).not.toMatch(/life insurance|homeowners|home claim/i);
    },
    30_000
  );

  it(
    "scenario 10.3: a single messy real-world message (identity + emotion + two claims + a direct question) still extracts correctly",
    async () => {
      const [step] = await runScenario([
        "This is so frustrating — my name is Margaret Chen, DOB 1985-03-15, phone 650-521-2836, " +
          "email margaret@email.com, SSN last four 4472, and I'm calling about my denied healthcare " +
          "claim from January but I also have a question about my auto claim — why was the healthcare one denied?"
      ]);

      // All 5 identity fields should be extracted and matched from one dense message.
      expect(step.state.identity.matchedFields.length).toBeGreaterThanOrEqual(3);
      expect(step.state.identity.verified).toBe(true);
      // The frustration should have been picked up despite everything else in the message.
      expect(step.state.lastEmotion).toBe("frustrated");
      // Some intent hint should have been captured despite two claims being mentioned.
      expect(step.state.memory.intentHint).toBeTruthy();
    },
    30_000
  );
});
