import type { LLMClient } from "../../llm/index.js";
import type { TurnAnalysis } from "../../memory/extract.js";
import type { ConversationState } from "../state.js";

export interface PhaseHandlerInput {
  state: ConversationState;
  analysis: TurnAnalysis;
  userMessage: string;
  llm: LLMClient;
}

export type PhaseHandler = (input: PhaseHandlerInput) => Promise<string>;
