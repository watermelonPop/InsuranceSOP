import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLLMClientOverride } from "../src/llm/index.js";
import { DONE_MESSAGE } from "../src/sop/phases/done.js";
import { createInitialState } from "../src/sop/state.js";
import { handleUserMessage } from "../src/sop/engine.js";
import { FakeLLMClient } from "./support/fakeLlm.js";

describe("DONE terminal state (mocked LLM)", () => {
  let fake: FakeLLMClient;

  beforeEach(() => {
    fake = new FakeLLMClient();
    setLLMClientOverride(fake);
  });

  afterEach(() => {
    setLLMClientOverride(undefined);
  });

  it("short-circuits to the fixed DONE message without any LLM call", async () => {
    const state = createInitialState();
    state.phase = "DONE";

    const result = await handleUserMessage(state, "Hello? Are you still there?");

    expect(result.reply).toBe(DONE_MESSAGE);
    expect(result.phase).toBe("DONE");
    expect(fake.conversationalCalls).toHaveLength(0);
  });
});
