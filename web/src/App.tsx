import { useEffect, useRef, useState } from "react";
import "./App.css";
import { getConversationState, resetConversation, sendMessage } from "./api";
import type { ChatMessage, DebugInfo } from "./types";

const PHASE_COLORS: Record<string, string> = {
  VERIFY_ID: "#d97706",
  RESOLVE_INTENT: "#2563eb",
  PROCESS_CASE: "#7c3aed",
  POST_PROCESS: "#0d9488",
  ESCALATED: "#dc2626",
  DONE: "#16a34a"
};

const ALL_IDENTITY_FIELDS: Array<{ key: string; label: string }> = [
  { key: "name", label: "Full name" },
  { key: "dob", label: "DOB" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "idLast4", label: "SSN/ID last 4" }
];

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [errorText, setErrorText] = useState<string | undefined>();
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState("VERIFY_ID");
  const [debug, setDebug] = useState<DebugInfo | undefined>();
  const [isSending, setIsSending] = useState(false);
  const [isSyncing, setIsSyncing] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // A page refresh only resets this component's React state, not the
  // server's single fixed conversation session (decision #6) — without this,
  // the UI would misleadingly show an empty VERIFY_ID chat while the server
  // is actually mid-conversation. Sync to the real server state on load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const state = await getConversationState();
        if (cancelled) return;
        setMessages(state.messages);
        setPhase(state.phase);
        setDebug(state.debug);
      } catch (err) {
        if (!cancelled) {
          setErrorText(err instanceof Error ? err.message : "Could not load the current conversation state.");
        }
      } finally {
        if (!cancelled) setIsSyncing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || isSending) return;

    setErrorText(undefined);
    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
    setInput("");
    setIsSending(true);

    try {
      const result = await sendMessage(trimmed);
      setMessages((prev) => [...prev, { role: "assistant", content: result.reply }]);
      setPhase(result.phase);
      setDebug(result.debug);
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : "Something went wrong sending that message.");
    } finally {
      setIsSending(false);
    }
  }

  async function handleReset() {
    setIsSending(true);
    setErrorText(undefined);
    try {
      const result = await resetConversation();
      setMessages([]);
      setPhase(result.phase);
      setDebug(undefined);
      setInput("");
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : "Could not reset the conversation.");
    } finally {
      setIsSending(false);
    }
  }

  // The conversation-signals section (emotion/off-topic streak) never
  // applies once the call has ended — nothing left to react to.
  const isConversationOver = phase === "ESCALATED" || phase === "DONE";
  const showEmotion = !isConversationOver && Boolean(debug?.lastEmotion) && debug?.lastEmotion !== "neutral";
  const showOffTopicStreak = !isConversationOver && (debug?.offTopicStreak ?? 0) > 0;

  return (
    <div className="app">
      <header className="app-header">
        <h1>Insurance Claims SOP Agent — Test Console</h1>
        <button className="reset-button" onClick={handleReset} disabled={isSending || isSyncing}>
          Reset conversation
        </button>
      </header>

      <div className="main-layout">
        <div className="chat-column">
          <div className="messages">
            {isSyncing && <div className="empty-state">Loading conversation…</div>}
            {!isSyncing && messages.length === 0 && (
              <div className="empty-state">
                Say hello to get started — try identifying yourself as a policyholder to begin verification.
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`message ${m.role}`}>
                {m.content}
              </div>
            ))}
            {errorText && <div className="message error">{errorText}</div>}
            <div ref={messagesEndRef} />
          </div>

          <div className="input-row">
            <input
              value={input}
              disabled={isSending || isSyncing}
              placeholder="Type a message…"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSend();
              }}
            />
            <button onClick={handleSend} disabled={isSending || isSyncing || !input.trim()}>
              {isSending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>

        <aside className="sidebar">
          <h2>Phase</h2>
          <span className="phase-badge" style={{ background: PHASE_COLORS[phase] ?? "#6b7280" }}>
            {phase}
          </span>

          {phase === "VERIFY_ID" && (
            <>
              <h2>Identity verification</h2>
              <div>
                {ALL_IDENTITY_FIELDS.map((f) => {
                  const matched = debug?.matchedFields.includes(f.key);
                  return (
                    <span key={f.key} className={`field-chip ${matched ? "" : "missing"}`}>
                      {matched ? "✓ " : ""}
                      {f.label}
                    </span>
                  );
                })}
              </div>
              <div className="debug-row">
                <span className="debug-label">Verified</span>
                <span className="debug-value">{debug?.verified ? "Yes" : "No"}</span>
              </div>
            </>
          )}

          {(phase === "RESOLVE_INTENT" || phase === "PROCESS_CASE") && debug?.memory.intentHint && (
            <>
              <h2>Remembered intent</h2>
              <div className="debug-row">
                <span className="debug-label">Intent hint</span>
                <span className="debug-value">{debug.memory.intentHint}</span>
              </div>
            </>
          )}

          {(phase === "PROCESS_CASE" || phase === "POST_PROCESS" || phase === "DONE") && debug?.resolvedCaseId && (
            <>
              <h2>Claim</h2>
              <div className="debug-row">
                <span className="debug-label">Resolved case</span>
                <span className="debug-value">{debug.resolvedCaseId}</span>
              </div>
            </>
          )}

          {(phase === "POST_PROCESS" || phase === "DONE") && (
            <>
              <h2>Email summary</h2>
              <div className="debug-row">
                <span className="debug-label">Email decision</span>
                <span className="debug-value">{debug?.emailDecision ?? "pending"}</span>
              </div>
            </>
          )}

          {(showEmotion || showOffTopicStreak) && (
            <>
              <h2>Conversation signals</h2>
              {showEmotion && (
                <div className="debug-row">
                  <span className="debug-label">Last emotion</span>
                  <span className="debug-value">{debug?.lastEmotion}</span>
                </div>
              )}
              {showOffTopicStreak && (
                <div className="debug-row">
                  <span className="debug-label">Off-topic streak</span>
                  <span className="debug-value">{debug?.offTopicStreak}</span>
                </div>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
