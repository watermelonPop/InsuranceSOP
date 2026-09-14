import { describe, expect, it, vi } from "vitest";
import { analyzeTurn } from "../src/memory/extract.js";
import type { LLMClient, LLMCompleteOptions } from "../src/llm/index.js";

function clientReturning(...responses: string[]): LLMClient {
  const queue = [...responses];
  return {
    complete: vi.fn(async (_opts: LLMCompleteOptions) => {
      const next = queue.shift();
      if (next === undefined) throw new Error("clientReturning: ran out of scripted responses");
      return next;
    })
  };
}

describe("analyzeTurn", () => {
  it("parses a well-formed extraction response", async () => {
    const client = clientReturning(
      JSON.stringify({
        pii: { name: "Margaret Chen", dob: "1985-03-15", phone: null, email: null, idLast4: "4472" },
        intentHint: "denied healthcare claim from January",
        caseTypeHint: "healthcare",
        emotion: "neutral",
        inScope: true
      })
    );

    const result = await analyzeTurn(client, [], "My name is Margaret Chen...");
    expect(result.pii.name).toBe("Margaret Chen");
    expect(result.pii.idLast4).toBe("4472");
    expect(result.intentHint).toBe("denied healthcare claim from January");
    expect(result.emotion).toBe("neutral");
    expect(result.inScope).toBe(true);
  });

  it("scenario 2.3 (see DECISIONS.md #37): discards an intentHint that's actually just describing providing identity/verification info, not a real reason for calling", async () => {
    const client = clientReturning(
      JSON.stringify({
        pii: { name: null, dob: null, phone: null, email: null, idLast4: "4472" },
        intentHint: "providing ID last 4 digits for verification",
        caseTypeHint: null,
        emotion: "neutral",
        inScope: true
      })
    );

    const result = await analyzeTurn(client, [], "4472");
    expect(result.intentHint).toBeNull();
  });

  it("still keeps a real, topical intentHint even when it co-occurs with identity fields", async () => {
    const client = clientReturning(
      JSON.stringify({
        pii: { name: "Margaret Chen", dob: null, phone: null, email: null, idLast4: null },
        intentHint: "denied healthcare claim from January",
        caseTypeHint: "healthcare",
        emotion: "neutral",
        inScope: true
      })
    );

    const result = await analyzeTurn(client, [], "Margaret Chen, calling about my denied healthcare claim from January.");
    expect(result.intentHint).toBe("denied healthcare claim from January");
  });

  it("requests JSON mode and passes recent prior turns as context (capped at 6)", async () => {
    const client = clientReturning(
      JSON.stringify({ pii: {}, intentHint: null, caseTypeHint: null, emotion: "neutral", inScope: true })
    );
    const priorTurns = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `turn ${i}`
    }));

    await analyzeTurn(client, priorTurns, "latest message");

    const call = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as LLMCompleteOptions;
    expect(call.jsonMode).toBe(true);
    // 6 prior turns + the latest message = 7
    expect(call.messages).toHaveLength(7);
    expect(call.messages.at(-1)).toEqual({ role: "user", content: "latest message" });
  });

  it("retries once on malformed JSON, then succeeds on the second attempt", async () => {
    const client = clientReturning(
      "not json at all",
      JSON.stringify({ pii: {}, intentHint: "hint", caseTypeHint: null, emotion: "neutral", inScope: true })
    );

    const result = await analyzeTurn(client, [], "hi");
    expect(result.intentHint).toBe("hint");
    expect(client.complete).toHaveBeenCalledTimes(2);
  });

  it("falls back to permissive defaults (fail open) if both attempts return malformed JSON", async () => {
    const client = clientReturning("not json", "also not json");

    const result = await analyzeTurn(client, [], "hi");
    expect(result).toEqual({
      pii: { name: null, dob: null, phone: null, email: null, idLast4: null },
      intentHint: null,
      caseTypeHint: null,
      emotion: "neutral",
      inScope: true,
      callerRole: null,
      representativeName: null
    });
  });

  it("tolerates prose wrapped around the JSON object", async () => {
    const client = clientReturning(
      `Sure, here's the analysis:\n${JSON.stringify({
        pii: {},
        intentHint: null,
        caseTypeHint: null,
        emotion: "frustrated",
        inScope: true
      })}\nLet me know if that helps!`
    );

    const result = await analyzeTurn(client, [], "hi");
    expect(result.emotion).toBe("frustrated");
  });

  it("defaults missing optional fields in an otherwise-valid JSON object", async () => {
    const client = clientReturning(JSON.stringify({}));

    const result = await analyzeTurn(client, [], "hi");
    expect(result.emotion).toBe("neutral");
    expect(result.inScope).toBe(true);
    expect(result.pii).toEqual({ name: null, dob: null, phone: null, email: null, idLast4: null });
  });
});
