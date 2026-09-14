import { getLLMClient } from "../llm/index.js";
import { applyScopeGuardrail } from "../guardrails/scope.js";
import { ESCALATION_HANDOFF_MESSAGE, isAffirmativeResponse } from "../guardrails/escalation.js";
import { isClosingSignal } from "../guardrails/closing.js";
import {
  isRepresentativeEnrollmentRequest,
  REPRESENTATIVE_ENROLLMENT_NOT_SUPPORTED_MESSAGE
} from "../guardrails/unsupportedCapabilities.js";
import { analyzeTurn } from "../memory/extract.js";
import { DONE_MESSAGE, handleDone } from "./phases/done.js";
import { handleEscalated } from "./phases/escalated.js";
import { handlePostProcess } from "./phases/postProcess.js";
import { handleProcessCase } from "./phases/processCase.js";
import { handleResolveIntent } from "./phases/resolveIntent.js";
import { handleVerifyId } from "./phases/verifyId.js";
import type { PhaseHandler } from "./phases/types.js";
import type { ConversationState } from "./state.js";

const PHASE_HANDLERS: Record<ConversationState["phase"], PhaseHandler> = {
  VERIFY_ID: handleVerifyId,
  RESOLVE_INTENT: handleResolveIntent,
  PROCESS_CASE: handleProcessCase,
  POST_PROCESS: handlePostProcess,
  ESCALATED: handleEscalated,
  DONE: handleDone
};

function mergeMemory(state: ConversationState, analysis: Awaited<ReturnType<typeof analyzeTurn>>) {
  // PII is accumulated onto the identity claim regardless of phase, so a
  // caller who volunteers fields early doesn't have to repeat them.
  if (analysis.pii.name) state.identity.claimed.name = analysis.pii.name;
  if (analysis.pii.dob) state.identity.claimed.dob = analysis.pii.dob;
  if (analysis.pii.phone) state.identity.claimed.phone = analysis.pii.phone;
  if (analysis.pii.email) state.identity.claimed.email = analysis.pii.email;
  if (analysis.pii.idLast4) state.identity.claimed.idLast4 = analysis.pii.idLast4;

  // Intent/case hints volunteered early (e.g. during VERIFY_ID) are stored
  // for RESOLVE_INTENT/PROCESS_CASE to use instead of re-asking from scratch.
  // Only trust hints from in-scope turns, so an off-topic aside can't
  // clobber a genuine hint captured earlier.
  if (analysis.inScope) {
    if (analysis.intentHint) state.memory.intentHint = analysis.intentHint;
    if (analysis.caseTypeHint) state.memory.caseTypeHint = analysis.caseTypeHint;
  }

  state.lastEmotion = analysis.emotion;
}

export interface EngineResult {
  reply: string;
  phase: ConversationState["phase"];
}

export async function handleUserMessage(state: ConversationState, userMessage: string): Promise<EngineResult> {
  // Terminal states: once escalated or done, the conversation is over. Skip
  // everything else (including LLM calls) so they stay fixed and predictable.
  if (state.phase === "ESCALATED") {
    return { reply: ESCALATION_HANDOFF_MESSAGE, phase: state.phase };
  }
  if (state.phase === "DONE") {
    return { reply: DONE_MESSAGE, phase: state.phase };
  }

  // A human-transfer offer is only "live" for the single turn right after it
  // was made; check acceptance deterministically before running the normal
  // pipeline (and before spending an LLM call on it).
  if (state.humanTransferOffered) {
    state.humanTransferOffered = false;
    // A goodbye ("okay, bye") can loosely match isAffirmativeResponse's
    // generic "okay" — checked first so a caller ending the call is never
    // misread as accepting the transfer offer instead (see DECISIONS.md #35).
    if (!isClosingSignal(userMessage) && isAffirmativeResponse(userMessage)) {
      state.phase = "ESCALATED";
      state.historyForLLM.push({ role: "user", content: userMessage });
      state.historyForLLM.push({ role: "assistant", content: ESCALATION_HANDOFF_MESSAGE });
      return { reply: ESCALATION_HANDOFF_MESSAGE, phase: state.phase };
    }
  }

  // Adding/authorizing a new representative isn't a capability this system
  // has at all (see DECISIONS.md #28) — caught deterministically, before
  // any LLM call, so it can never fabricate a fake enrollment flow for it.
  if (isRepresentativeEnrollmentRequest(userMessage)) {
    state.humanTransferOffered = true;
    state.historyForLLM.push({ role: "user", content: userMessage });
    state.historyForLLM.push({ role: "assistant", content: REPRESENTATIVE_ENROLLMENT_NOT_SUPPORTED_MESSAGE });
    return { reply: REPRESENTATIVE_ENROLLMENT_NOT_SUPPORTED_MESSAGE, phase: state.phase };
  }

  const llm = getLLMClient();

  const priorTurns = state.historyForLLM.map((m) => ({
    role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: m.content
  }));

  const analysis = await analyzeTurn(llm, priorTurns, userMessage);
  mergeMemory(state, analysis);

  const scopeResult = applyScopeGuardrail(state, analysis.inScope);

  let reply: string;
  if (scopeResult.blocked) {
    reply = scopeResult.reply!;
  } else {
    const handler = PHASE_HANDLERS[state.phase];
    try {
      reply = await handler({ state, analysis, userMessage, llm });
    } catch (err) {
      // The phase handler's conversational LLM call failed (provider outage,
      // exhausted quota, etc) — analyzeTurn already fails open on its own
      // errors, but this call has no fallback content to give, so degrade
      // gracefully in-character rather than surfacing a raw 500 to the UI.
      console.error("Phase handler LLM call failed:", err);
      reply =
        "Sorry, I'm having trouble connecting to our systems right now. Please try again in a moment, or let me know if you'd like to be transferred to a human representative.";
      state.humanTransferOffered = true;
    }
  }

  state.historyForLLM.push({ role: "user", content: userMessage });
  state.historyForLLM.push({ role: "assistant", content: reply });

  return { reply, phase: state.phase };
}
