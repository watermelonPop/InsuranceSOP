import type { LLMClient, LLMCompleteOptions } from "./types.js";

const DEFAULT_MODEL = "gemini-flash-latest";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiPart {
  text: string;
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

export class GeminiClient implements LLMClient {
  private readonly model: string;

  constructor(private readonly apiKey: string, model?: string) {
    if (!apiKey) {
      throw new Error("GeminiClient requires a non-empty API key");
    }
    this.model = model || DEFAULT_MODEL;
  }

  async complete(options: LLMCompleteOptions): Promise<string> {
    const contents: GeminiContent[] = options.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    }));

    const generationConfig: Record<string, unknown> = {
      temperature: options.temperature ?? 0.4,
      maxOutputTokens: options.maxOutputTokens ?? 1024,
    };
    if (options.jsonMode) {
      generationConfig.responseMimeType = "application/json";
    }

    const body: Record<string, unknown> = { contents, generationConfig };

    if (options.system) {
      body.systemInstruction = { parts: [{ text: options.system }] };
    }

    const url = `${API_BASE}/${this.model}:generateContent?key=${this.apiKey}`;

    // The free-tier backend occasionally returns transient 503 "high demand"
    // errors (retry with short backoff) and per-minute 429 rate-limit errors
    // (retry once, honoring the server's requested retryDelay). A 429 tied to
    // a per-DAY quota is not worth retrying within a request's lifetime.
    const maxAttempts = 3;
    let lastErrorText = "";
    let lastStatus = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

      if (res.ok) {
        const data = (await res.json()) as GeminiResponse;
        return this.extractText(data);
      }

      lastStatus = res.status;
      lastErrorText = await res.text().catch(() => "");

      const isLastAttempt = attempt === maxAttempts;
      if (res.status === 503 && !isLastAttempt) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
        continue;
      }

      if (res.status === 429 && !isLastAttempt) {
        const retryDelaySeconds = this.parseRetryDelaySeconds(lastErrorText);
        const isPerDayQuota = lastErrorText.includes("PerDay");
        if (retryDelaySeconds !== undefined && !isPerDayQuota && retryDelaySeconds <= 65) {
          await new Promise((resolve) => setTimeout(resolve, retryDelaySeconds * 1000));
          continue;
        }
      }

      throw new Error(`Gemini API error ${res.status}: ${lastErrorText}`);
    }

    throw new Error(`Gemini API error ${lastStatus}: ${lastErrorText}`);
  }

  private parseRetryDelaySeconds(errorText: string): number | undefined {
    const match = errorText.match(/"retryDelay"\s*:\s*"(\d+)s"/);
    return match ? Number(match[1]) : undefined;
  }

  private extractText(data: GeminiResponse): string {

    if (data.promptFeedback?.blockReason) {
      throw new Error(`Gemini blocked the request: ${data.promptFeedback.blockReason}`);
    }

    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
    if (!text) {
      throw new Error("Gemini returned an empty response");
    }
    return text;
  }
}
