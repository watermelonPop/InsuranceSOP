import { GeminiClient } from "./geminiClient.js";
import { GroqClient } from "./groqClient.js";
import type { LLMClient } from "./types.js";

export type { LLMClient, LLMMessage, LLMCompleteOptions, LLMRole } from "./types.js";

let cachedClient: LLMClient | undefined;
let testOverride: LLMClient | undefined;

/** Test-only hook: force getLLMClient() to return a fake/scripted client instead of a real provider. */
export function setLLMClientOverride(client: LLMClient | undefined): void {
  testOverride = client;
}

/** Provider-agnostic factory: swap providers by setting LLM_PROVIDER and adding an adapter case. */
export function getLLMClient(): LLMClient {
  if (testOverride) return testOverride;
  if (cachedClient) return cachedClient;

  const provider = process.env.LLM_PROVIDER ?? "groq";

  switch (provider) {
    case "groq": {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) {
        throw new Error("GROQ_API_KEY is not set (required when LLM_PROVIDER=groq)");
      }
      cachedClient = new GroqClient(apiKey, process.env.GROQ_MODEL);
      return cachedClient;
    }
    case "gemini": {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY is not set (required when LLM_PROVIDER=gemini)");
      }
      cachedClient = new GeminiClient(apiKey, process.env.GEMINI_MODEL);
      return cachedClient;
    }
    default:
      throw new Error(`Unknown LLM_PROVIDER "${provider}"`);
  }
}
