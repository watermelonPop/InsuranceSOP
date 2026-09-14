import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLLMClientOverride } from "../src/llm/index.js";
import { handleUserMessage } from "../src/sop/engine.js";
import { createInitialState } from "../src/sop/state.js";
import { FakeLLMClient, neutralAnalysis } from "./support/fakeLlm.js";

describe("scenario 10.2: garbled/weird input doesn't crash the engine", () => {
  let fake: FakeLLMClient;

  beforeEach(() => {
    fake = new FakeLLMClient();
    setLLMClientOverride(fake);
  });

  afterEach(() => {
    setLLMClientOverride(undefined);
  });

  const weirdInputs = ["😀😀😀", "k", "", "   ", "asdkjhaskjdh alkjsdh", "!!!???...", "a".repeat(2000)];

  for (const input of weirdInputs) {
    it(`handles ${JSON.stringify(input.slice(0, 20))} without throwing`, async () => {
      fake.queueExtraction(neutralAnalysis());
      const state = createInitialState();
      const result = await handleUserMessage(state, input);
      expect(typeof result.reply).toBe("string");
      expect(result.phase).toBe("VERIFY_ID");
    });
  }
});

describe("scenario 10.3: a rich 'kitchen sink' turn (identity + emotion + intent + off-topic-adjacent) merges correctly", () => {
  let fake: FakeLLMClient;

  beforeEach(() => {
    fake = new FakeLLMClient();
    setLLMClientOverride(fake);
  });

  afterEach(() => {
    setLLMClientOverride(undefined);
  });

  it("merges every field from a single dense extraction result in one turn", async () => {
    // Mocking the extraction result directly (rather than relying on a real
    // model to parse messy input) tests the engine's merge logic under a
    // realistic "everything at once" analysis — it can't test whether the
    // real LLM's extraction quality holds up on genuinely messy text, which
    // needs a live pass (see TEST_SCENARIOS.md 10.3).
    fake.queueExtraction(
      neutralAnalysis({
        pii: { name: "Margaret Chen", dob: "1985-03-15", phone: "+16505212836", email: "margaret@email.com", idLast4: "4472" },
        intentHint: "denied healthcare claim from January, also asking about my auto claim",
        caseTypeHint: "healthcare",
        emotion: "frustrated",
        inScope: true
      })
    );

    const state = createInitialState();
    const result = await handleUserMessage(
      state,
      "This is so frustrating — my name is Margaret Chen, DOB 1985-03-15, phone 650-521-2836, email margaret@email.com, SSN last four 4472, and I'm calling about my denied healthcare claim from January but also have a question about my auto claim."
    );

    // All 5 identity fields merged and matched -> verified in one turn.
    expect(state.identity.matchedFields.sort()).toEqual(["dob", "email", "idLast4", "name", "phone"].sort());
    expect(state.identity.verified).toBe(true);
    expect(result.phase).toBe("RESOLVE_INTENT");
    // Both memory fields captured despite the message covering two topics.
    expect(state.memory.intentHint).toContain("denied healthcare claim");
    expect(state.memory.caseTypeHint).toBe("healthcare");
    expect(state.lastEmotion).toBe("frustrated");
  });
});
