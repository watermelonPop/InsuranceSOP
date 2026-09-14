import type { LLMClient, LLMCompleteOptions } from "../../src/llm/index.js";
import type { TurnAnalysis } from "../../src/memory/extract.js";

/**
 * Scripted LLMClient for deterministic tests. Extraction calls (jsonMode)
 * are answered from a queue of pre-scripted TurnAnalysis objects, one per
 * turn; conversational calls just return a fixed placeholder, since the
 * mocked test suite asserts on SOP mechanics (state/phase/memory), not
 * on prose quality.
 */
export class FakeLLMClient implements LLMClient {
  private extractionQueue: TurnAnalysis[] = [];
  private conversationalReplyQueue: string[] = [];
  public conversationalCalls: LLMCompleteOptions[] = [];

  queueExtraction(analysis: TurnAnalysis): this {
    this.extractionQueue.push(analysis);
    return this;
  }

  /** Scripts the next non-extraction (conversational) reply, instead of the default "[mock reply]". */
  queueConversation(reply: string): this {
    this.conversationalReplyQueue.push(reply);
    return this;
  }

  async complete(options: LLMCompleteOptions): Promise<string> {
    if (options.jsonMode) {
      const next = this.extractionQueue.shift();
      if (!next) {
        throw new Error("FakeLLMClient: no scripted extraction left in queue for this turn");
      }
      return JSON.stringify(next);
    }

    this.conversationalCalls.push(options);
    return this.conversationalReplyQueue.shift() ?? "[mock reply]";
  }
}

export function neutralAnalysis(overrides: Partial<TurnAnalysis> = {}): TurnAnalysis {
  const { pii: piiOverrides, ...rest } = overrides;
  return {
    pii: { name: null, dob: null, phone: null, email: null, idLast4: null, ...piiOverrides },
    intentHint: null,
    caseTypeHint: null,
    emotion: "neutral",
    inScope: true,
    callerRole: null,
    representativeName: null,
    ...rest
  };
}
