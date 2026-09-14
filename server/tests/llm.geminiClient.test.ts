import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiClient } from "../src/llm/geminiClient.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function textErrorResponse(status: number, text: string): Response {
  return new Response(text, { status });
}

describe("GeminiClient", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns the text of the first candidate on success", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: "hello there" }] } }]
      })
    ) as unknown as typeof fetch;

    const client = new GeminiClient("fake-key");
    const reply = await client.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(reply).toBe("hello there");
  });

  it("throws if the API blocks the prompt", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, { promptFeedback: { blockReason: "SAFETY" } })
    ) as unknown as typeof fetch;

    const client = new GeminiClient("fake-key");
    await expect(client.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/blocked/i);
  });

  it("retries on a transient 503 and succeeds on the next attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(textErrorResponse(503, "overloaded"))
      .mockResolvedValueOnce(jsonResponse(200, { candidates: [{ content: { parts: [{ text: "ok" }] } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new GeminiClient("fake-key");
    const reply = await client.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(reply).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("gives up after repeated 503s and throws", async () => {
    global.fetch = vi.fn().mockResolvedValue(textErrorResponse(503, "still overloaded")) as unknown as typeof fetch;

    const client = new GeminiClient("fake-key");
    await expect(client.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/503/);
  }, 10_000);

  it("does not retry a per-day quota 429 even when a retryDelay is present, and throws immediately", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      textErrorResponse(
        429,
        JSON.stringify({
          error: {
            details: [
              { violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] },
              { retryDelay: "30s" }
            ]
          }
        })
      )
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new GeminiClient("fake-key");
    await expect(client.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/429/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a per-minute quota 429 once, honoring the server's retryDelay", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        textErrorResponse(
          429,
          JSON.stringify({
            error: {
              details: [
                { violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }] },
                { retryDelay: "1s" }
              ]
            }
          })
        )
      )
      .mockResolvedValueOnce(jsonResponse(200, { candidates: [{ content: { parts: [{ text: "ok" }] } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new GeminiClient("fake-key");
    const reply = await client.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(reply).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("throws if the constructor is given an empty API key", () => {
    expect(() => new GeminiClient("")).toThrow(/non-empty API key/);
  });
});
