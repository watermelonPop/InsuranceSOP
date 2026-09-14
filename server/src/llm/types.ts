export type LLMRole = "system" | "user" | "assistant";

export interface LLMMessage {
  role: LLMRole;
  content: string;
}

export interface LLMCompleteOptions {
  /** System instructions steering this specific call (phase prompt, guardrail prompt, etc). */
  system?: string;
  messages: LLMMessage[];
  /** Keep responses short/deterministic for classifiers and extractors. */
  temperature?: number;
  maxOutputTokens?: number;
  /** Ask the provider to constrain output to valid JSON (used by structured extractors/classifiers). */
  jsonMode?: boolean;
}

export interface LLMClient {
  complete(options: LLMCompleteOptions): Promise<string>;
}
