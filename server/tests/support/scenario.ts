import { handleUserMessage, type EngineResult } from "../../src/sop/engine.js";
import { createInitialState, type ConversationState } from "../../src/sop/state.js";

export interface ScenarioStep {
  message: string;
  result: EngineResult;
  state: ConversationState;
}

/** Runs a sequence of user messages through the real SOP engine against whatever LLMClient is currently active (mock or live). */
export async function runScenario(messages: string[]): Promise<ScenarioStep[]> {
  const state = createInitialState();
  const steps: ScenarioStep[] = [];
  for (const message of messages) {
    const result = await handleUserMessage(state, message);
    steps.push({ message, result, state: structuredClone(state) });
  }
  return steps;
}
