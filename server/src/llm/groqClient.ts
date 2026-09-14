import type { LLMClient, LLMCompleteOptions } from "./types.js";

const DEFAULT_MODEL = "openai/gpt-oss-120b";
const API_URL = "https://api.groq.com/openai/v1/chat/completions";
const MAX_WORTHWHILE_RETRY_WAIT_SECONDS = 65;

interface GroqMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface GroqResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
}

export class GroqClient implements LLMClient {
  private readonly model: string;

  constructor(private readonly apiKey: string, model?: string) {
    if (!apiKey) {
      throw new Error("GroqClient requires a non-empty API key");
    }
    this.model = model || DEFAULT_MODEL;
  }

  async complete(options: LLMCompleteOptions): Promise<string> {
    const messages: GroqMessage[] = [];
    if (options.system) {
      messages.push({ role: "system", content: options.system });
    }
    for (const m of options.messages) {
      messages.push({ role: m.role, content: m.content });
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: options.temperature ?? 0.4,
      max_tokens: options.maxOutputTokens ?? 1024
    };
    if (options.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    const maxAttempts = 3;
    let lastErrorText = "";
    let lastStatus = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body)
      });

      if (res.ok) {
        const data = (await res.json()) as GroqResponse;
        const text = data.choices?.[0]?.message?.content ?? "";
        if (!text) {
          throw new Error("Groq returned an empty response");
        }
        return text;
      }

      lastStatus = res.status;
      lastErrorText = await res.text().catch(() => "");
      const isLastAttempt = attempt === maxAttempts;

      // 503/502 are transient server-side issues; 429 is a rate limit —
      // could be requests/min, tokens/min, OR tokens/day on the free tier.
      // Groq's error message names a suggested wait ("Please try again in
      // 3.4725s" or, for a daily cap, "4m18.77s") — honor it, but only
      // retry if the wait is short enough to plausibly clear within this
      // request; a multi-minute wait (e.g. a daily token cap) should fail
      // fast instead of burning all retry attempts on a pointless capped wait.
      if ((res.status === 503 || res.status === 502 || res.status === 429) && !isLastAttempt) {
        const suggestedSeconds = this.parseRetryAfterSeconds(lastErrorText);
        if (suggestedSeconds !== undefined && suggestedSeconds > MAX_WORTHWHILE_RETRY_WAIT_SECONDS) {
          throw new Error(`Groq API error ${res.status}: ${lastErrorText}`);
        }
        const waitMs = suggestedSeconds !== undefined ? Math.ceil(suggestedSeconds * 1000) + 250 : attempt * 1500;
        await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, MAX_WORTHWHILE_RETRY_WAIT_SECONDS * 1000)));
        continue;
      }

      throw new Error(`Groq API error ${res.status}: ${lastErrorText}`);
    }

    throw new Error(`Groq API error ${lastStatus}: ${lastErrorText}`);
  }

  /** Parses "Xs" or "XmYs" (as Groq uses for longer, e.g. daily-cap, waits) into total seconds. */
  private parseRetryAfterSeconds(errorText: string): number | undefined {
    const match = errorText.match(/try again in\s+(?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/i);
    if (!match) return undefined;
    const hours = match[1] ? Number(match[1]) : 0;
    const minutes = match[2] ? Number(match[2]) : 0;
    const seconds = Number(match[3]);
    return hours * 3600 + minutes * 60 + seconds;
  }
}
