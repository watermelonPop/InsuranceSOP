import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { handleUserMessage } from "../sop/engine.js";
import { getState, resetState } from "../session/store.js";
import type { ConversationState } from "../sop/state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function buildDebugPayload(state: ConversationState) {
  return {
    matchedFields: state.identity.matchedFields,
    verified: state.identity.verified,
    memory: state.memory,
    lastEmotion: state.lastEmotion,
    offTopicStreak: state.offTopicStreak,
    resolvedCaseId: state.resolvedCaseId,
    emailDecision: state.postProcess.emailDecision,
    callerRole: state.identity.callerRole,
    representativeName: state.identity.representativeName,
    representativeAuthorized: state.identity.representativeAuthorized
  };
}

const app = express();
app.use(cors());
app.use(express.json());

// Serves the built React app in Docker/production. In local dev this
// directory won't exist (the Vite dev server serves the UI instead on its
// own port and proxies API calls here) — skip mounting rather than crash.
// Dockerfile sets WEB_DIST_DIR=/app/web-dist explicitly since the compiled
// dist/ layout sits at a different depth than the source layout.
const WEB_DIST_DIR = process.env.WEB_DIST_DIR ?? path.resolve(__dirname, "../../../web/dist");
if (existsSync(WEB_DIST_DIR)) {
  app.use(express.static(WEB_DIST_DIR));
} else {
  console.log(`No built frontend found at ${WEB_DIST_DIR} — API-only mode (expected in local dev).`);
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/reset", (_req, res) => {
  const state = resetState();
  res.json({ phase: state.phase });
});

// Lets the UI resync to the real server-side session on load — a page
// refresh only resets client-side React state, not the single fixed
// conversation session (decision #6), so without this the UI could
// silently show a misleading "fresh" VERIFY_ID/empty-chat view while the
// server is actually mid-conversation (see DECISIONS.md #26).
app.get("/state", (_req, res) => {
  const state = getState();
  res.json({
    phase: state.phase,
    messages: state.historyForLLM.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content
    })),
    debug: buildDebugPayload(state)
  });
});

app.post("/message", async (req, res) => {
  const userMessage = typeof req.body?.message === "string" ? req.body.message : undefined;
  if (!userMessage) {
    res.status(400).json({ error: "Request body must include a string `message` field" });
    return;
  }

  try {
    const state = getState();
    const result = await handleUserMessage(state, userMessage);
    res.json({
      reply: result.reply,
      phase: result.phase,
      debug: buildDebugPayload(state)
    });
  } catch (err) {
    console.error("Error handling message:", err);
    res.status(500).json({ error: "Internal error handling message" });
  }
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
app.listen(PORT, () => {
  console.log(`SOP server listening on http://localhost:${PORT}`);
});
