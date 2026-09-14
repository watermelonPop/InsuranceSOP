import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import type { DebugInfo, SendMessageResponse } from "../src/types";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function fullDebug(overrides: Partial<DebugInfo> = {}): DebugInfo {
  return {
    matchedFields: [],
    verified: false,
    memory: {},
    lastEmotion: "neutral",
    offTopicStreak: 0,
    ...overrides
  };
}

/** Renders the app, sends one message, and mocks /message to return the given response. */
async function sendAndGet(response: SendMessageResponse) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/state")) {
      // Mount-time sync to server state — an empty/fresh session for these tests.
      return Promise.resolve(
        jsonResponse({ phase: "VERIFY_ID", messages: [], debug: fullDebug() })
      );
    }
    return Promise.resolve(jsonResponse(response));
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<App />);
  const user = userEvent.setup();

  await waitFor(() => {
    expect(screen.getByPlaceholderText("Type a message…")).not.toBeDisabled();
  });

  await user.type(screen.getByPlaceholderText("Type a message…"), "hello");
  await user.click(screen.getByRole("button", { name: /send/i }));

  await waitFor(() => {
    expect(screen.getByText(response.reply)).toBeInTheDocument();
  });

  return { fetchMock, user };
}

describe("App — chat + debug sidebar", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("syncing to the real server state on load (see DECISIONS.md #26)", () => {
    it("restores messages, phase, and debug info from GET /state instead of assuming a fresh session", async () => {
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/state")) {
          return Promise.resolve(
            jsonResponse({
              phase: "PROCESS_CASE",
              messages: [
                { role: "user", content: "My name is Margaret Chen..." },
                { role: "assistant", content: "You're verified, Margaret." }
              ],
              debug: fullDebug({ verified: true, resolvedCaseId: "CL-2048" })
            })
          );
        }
        return Promise.resolve(jsonResponse({}));
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      render(<App />);

      await waitFor(() => {
        expect(screen.getByText("You're verified, Margaret.")).toBeInTheDocument();
      });
      expect(screen.getByText("My name is Margaret Chen...")).toBeInTheDocument();
      expect(screen.getByText("PROCESS_CASE")).toBeInTheDocument();
      expect(screen.getByText("CL-2048")).toBeInTheDocument();
      // Not the misleading fresh-session empty state, since a real prior conversation was restored.
      expect(screen.queryByText(/say hello to get started/i)).not.toBeInTheDocument();
    });

    it("shows the empty-session state when the server genuinely has no conversation yet", async () => {
      const fetchMock = vi.fn(() =>
        Promise.resolve(jsonResponse({ phase: "VERIFY_ID", messages: [], debug: fullDebug() }))
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      render(<App />);

      await waitFor(() => {
        expect(screen.getByText(/say hello to get started/i)).toBeInTheDocument();
      });
    });
  });

  describe("scenario 9.2: Reset conversation button", () => {
    it("clears messages and returns the sidebar to VERIFY_ID state", async () => {
      const { user } = await sendAndGet({
        reply: "Thanks, verifying now.",
        phase: "RESOLVE_INTENT",
        debug: fullDebug({ matchedFields: ["name", "dob", "idLast4"], verified: true, memory: { intentHint: "denied claim" } })
      });

      // Sanity: we did move into RESOLVE_INTENT before resetting.
      expect(screen.getByText("RESOLVE_INTENT")).toBeInTheDocument();
      expect(screen.getByText("denied claim")).toBeInTheDocument();

      global.fetch = vi.fn().mockResolvedValue(jsonResponse({ phase: "VERIFY_ID" })) as unknown as typeof fetch;
      await user.click(screen.getByRole("button", { name: /reset conversation/i }));

      await waitFor(() => {
        expect(screen.getByText("VERIFY_ID")).toBeInTheDocument();
      });

      // Chat history cleared back to the empty state.
      expect(screen.getByText(/say hello to get started/i)).toBeInTheDocument();
      expect(screen.queryByText("Thanks, verifying now.")).not.toBeInTheDocument();
      // Sidebar cleared too — no leftover memory from before the reset.
      expect(screen.queryByText("denied claim")).not.toBeInTheDocument();
      // Back in VERIFY_ID, so the identity checklist reappears.
      expect(screen.getByText("Identity verification")).toBeInTheDocument();
    });
  });

  describe("scenario 9.3: phase-conditional sidebar sections", () => {
    it("VERIFY_ID: shows identity checklist only, no intent/claim/email sections", async () => {
      await sendAndGet({
        reply: "Need more info.",
        phase: "VERIFY_ID",
        debug: fullDebug({ matchedFields: ["name"] })
      });

      expect(screen.getByText("Identity verification")).toBeInTheDocument();
      expect(screen.getByText("✓ Full name")).toBeInTheDocument();
      expect(screen.queryByText("Remembered intent")).not.toBeInTheDocument();
      expect(screen.queryByText("Claim")).not.toBeInTheDocument();
      expect(screen.queryByText("Email summary")).not.toBeInTheDocument();
    });

    it("RESOLVE_INTENT: shows the remembered intent hint, hides the identity checklist", async () => {
      await sendAndGet({
        reply: "Let me check.",
        phase: "RESOLVE_INTENT",
        debug: fullDebug({
          matchedFields: ["name", "dob", "idLast4"],
          verified: true,
          memory: { intentHint: "denied healthcare claim from January" }
        })
      });

      expect(screen.getByText("Remembered intent")).toBeInTheDocument();
      expect(screen.getByText("denied healthcare claim from January")).toBeInTheDocument();
      expect(screen.queryByText("Identity verification")).not.toBeInTheDocument();
      expect(screen.queryByText("Claim")).not.toBeInTheDocument();
    });

    it("PROCESS_CASE: shows both the intent hint and the resolved claim", async () => {
      await sendAndGet({
        reply: "It was denied because...",
        phase: "PROCESS_CASE",
        debug: fullDebug({
          matchedFields: ["name", "dob", "idLast4"],
          verified: true,
          memory: { intentHint: "denied healthcare claim from January" },
          resolvedCaseId: "CL-2048"
        })
      });

      expect(screen.getByText("Remembered intent")).toBeInTheDocument();
      expect(screen.getByText("Claim")).toBeInTheDocument();
      expect(screen.getByText("CL-2048")).toBeInTheDocument();
      expect(screen.queryByText("Identity verification")).not.toBeInTheDocument();
    });

    it("POST_PROCESS: shows the claim and a pending email decision", async () => {
      await sendAndGet({
        reply: "Here's your summary. Want it emailed?",
        phase: "POST_PROCESS",
        debug: fullDebug({ resolvedCaseId: "CL-2048" })
      });

      expect(screen.getByText("Email summary")).toBeInTheDocument();
      expect(screen.getByText("pending")).toBeInTheDocument();
      expect(screen.getByText("Claim")).toBeInTheDocument();
    });

    it("DONE: shows the final email decision, and hides emotion/off-topic signals even if set", async () => {
      await sendAndGet({
        reply: "This call has ended.",
        phase: "DONE",
        debug: fullDebug({ resolvedCaseId: "CL-2048", emailDecision: "sent", lastEmotion: "frustrated", offTopicStreak: 2 })
      });

      expect(screen.getByText("Email summary")).toBeInTheDocument();
      expect(screen.getByText("sent")).toBeInTheDocument();
      // DONE explicitly suppresses the conversation-signals section regardless of emotion/streak.
      expect(screen.queryByText("Conversation signals")).not.toBeInTheDocument();
    });

    it("ESCALATED: shows only the phase badge, nothing else", async () => {
      await sendAndGet({
        reply: "Connecting you to a human representative now.",
        phase: "ESCALATED",
        debug: fullDebug({ lastEmotion: "angry", offTopicStreak: 3 })
      });

      expect(screen.getByText("ESCALATED")).toBeInTheDocument();
      expect(screen.queryByText("Identity verification")).not.toBeInTheDocument();
      expect(screen.queryByText("Remembered intent")).not.toBeInTheDocument();
      expect(screen.queryByText("Claim")).not.toBeInTheDocument();
      expect(screen.queryByText("Email summary")).not.toBeInTheDocument();
      expect(screen.queryByText("Conversation signals")).not.toBeInTheDocument();
    });

    it("shows the Conversation signals section only when emotion is non-neutral or off-topic streak > 0", async () => {
      await sendAndGet({
        reply: "I understand this is frustrating.",
        phase: "VERIFY_ID",
        debug: fullDebug({ lastEmotion: "frustrated" })
      });
      expect(screen.getByText("Conversation signals")).toBeInTheDocument();
      expect(screen.getByText("frustrated")).toBeInTheDocument();
    });

    it("hides the Conversation signals section when emotion is neutral and off-topic streak is 0", async () => {
      await sendAndGet({
        reply: "Sure, what's your date of birth?",
        phase: "VERIFY_ID",
        debug: fullDebug({ lastEmotion: "neutral", offTopicStreak: 0 })
      });
      expect(screen.queryByText("Conversation signals")).not.toBeInTheDocument();
    });
  });
});
