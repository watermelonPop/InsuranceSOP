import { afterEach, describe, expect, it, vi } from "vitest";
import { GroqClient } from "../src/llm/groqClient.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function textErrorResponse(status: number, text: string): Response {
  return new Response(text, { status });
}

describe("GroqClient", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns the assistant message content on success", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { choices: [{ message: { content: "hello there" } }] })) as unknown as typeof fetch;

    const client = new GroqClient("fake-key");
    const reply = await client.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(reply).toBe("hello there");
  });

  it("sends a system message and response_format when jsonMode is set", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { choices: [{ message: { content: "{}" } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new GroqClient("fake-key");
    await client.complete({ system: "be terse", jsonMode: true, messages: [{ role: "user", content: "hi" }] });

    const sentBody = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(sentBody.messages[0]).toEqual({ role: "system", content: "be terse" });
    expect(sentBody.response_format).toEqual({ type: "json_object" });
  });

  it("throws on an empty response", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(200, { choices: [{ message: { content: "" } }] })) as unknown as typeof fetch;

    const client = new GroqClient("fake-key");
    await expect(client.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/empty/i);
  });

  it("retries on a transient 503/429/502 and succeeds on a later attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(textErrorResponse(503, "overloaded"))
      .mockResolvedValueOnce(textErrorResponse(429, "rate limited"))
      .mockResolvedValueOnce(jsonResponse(200, { choices: [{ message: { content: "ok" } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new GroqClient("fake-key");
    const reply = await client.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(reply).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 10_000);

  it("throws immediately on a non-retryable error status (e.g. 500)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(textErrorResponse(500, "server error"));
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new GroqClient("fake-key");
    await expect(client.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors Groq's suggested wait time from a token-rate-limit 429 message", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        textErrorResponse(429, "Rate limit reached ... Please try again in 0.2s.")
      )
      .mockResolvedValueOnce(jsonResponse(200, { choices: [{ message: { content: "ok" } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new GroqClient("fake-key");
    const start = Date.now();
    const reply = await client.complete({ messages: [{ role: "user", content: "hi" }] });
    const elapsed = Date.now() - start;

    expect(reply).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Should wait roughly the suggested 0.2s (plus a small buffer), not the fixed 1.5s fallback.
    expect(elapsed).toBeLessThan(1000);
  });

  it("fails fast (no retry) on a daily-cap-scale 429 wait, instead of burning attempts on a useless capped wait", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        textErrorResponse(
          429,
          "Rate limit reached for model ... on tokens per day (TPD): Limit 200000, Used 199604, Requested 861. Please try again in 4m18.767999999s."
        )
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new GroqClient("fake-key");
    const start = Date.now();
    await expect(client.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/429/);
    const elapsed = Date.now() - start;

    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry attempted
    expect(elapsed).toBeLessThan(1000); // failed fast, did not wait anywhere near 4m18s
  });

  it("gives up after exhausting retries on a persistently retryable error and throws", async () => {
    global.fetch = vi.fn().mockResolvedValue(textErrorResponse(503, "still overloaded")) as unknown as typeof fetch;

    const client = new GroqClient("fake-key");
    await expect(client.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/503/);
  }, 10_000);

  it("throws if the constructor is given an empty API key", () => {
    expect(() => new GroqClient("")).toThrow(/non-empty API key/);
  });
});
