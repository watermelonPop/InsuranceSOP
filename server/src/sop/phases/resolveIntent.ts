import { isClosingSignal } from "../../guardrails/closing.js";
import { getClaimsForParty } from "../../tools/claims.js";
import { askWhichClaim, pickBestClaim } from "./claimResolution.js";
import { handleProcessCase } from "./processCase.js";
import type { PhaseHandler } from "./types.js";

const ZERO_CLAIMS_MESSAGE =
  "I don't see any claims on file for your account yet. Would you like me to connect you with a human representative to look into that, or is there something else I can help with?";
// Shared by both RESOLVE_INTENT exit paths (zero claims, and ambiguous/no
// claim resolved yet) — neither has any case-specific data to summarize, so
// both skip POST_PROCESS's email-summary flow entirely (see DECISIONS.md #34).
const RESOLVE_INTENT_CLOSING_MESSAGE = "No problem, thanks for calling — have a great day!";

/**
 * Resolves which of the caller's claims they mean, preferring the memory
 * hint captured earlier (even in VERIFY_ID) over asking from scratch.
 * Only resolves when there's a single unambiguous best match; otherwise
 * asks a grounded clarifying question listing their actual claims.
 */
export const handleResolveIntent: PhaseHandler = async ({ state, analysis, userMessage, llm }) => {
  if (!state.identity.partyId) {
    // Shouldn't happen once verified, but fail safe rather than crash on missing data.
    return "Let me just double check a couple things on your account first — could you remind me what you're calling about?";
  }

  // A caller who says goodbye before any claim is ever resolved has nothing
  // for PROCESS_CASE/POST_PROCESS to wrap up — checked before either branch
  // below, so it applies whether or not they have claims on file at all
  // (see DECISIONS.md #34, tightened by #40).
  if (isClosingSignal(userMessage)) {
    state.phase = "DONE";
    return RESOLVE_INTENT_CLOSING_MESSAGE;
  }

  const claims = getClaimsForParty(state.identity.partyId);

  if (claims.length === 0) {
    // The message itself offers a human transfer — that offer must actually
    // be "live" for the deterministic acceptance check on the next turn,
    // the same way every other transfer offer in this system works.
    state.humanTransferOffered = true;
    return ZERO_CLAIMS_MESSAGE;
  }

  const resolved = pickBestClaim(claims, state.memory.caseTypeHint, state.memory.intentHint);

  if (resolved) {
    state.resolvedCaseId = resolved.case_id;
    state.phase = "PROCESS_CASE";
    state.claimJustResolved = true;

    // Chain straight into PROCESS_CASE on the same message rather than
    // returning a separate "found it, ask me anything" confirmation this
    // turn (see DECISIONS.md #18) — PROCESS_CASE answers immediately instead.
    return handleProcessCase({ state, analysis, userMessage, llm });
  }

  return askWhichClaim({
    claims,
    userMessage,
    emotion: analysis.emotion,
    contextMessages: state.historyForLLM.slice(-6),
    llm
  });
};
