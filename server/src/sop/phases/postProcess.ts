import { isAffirmativeResponse } from "../../guardrails/escalation.js";
import type { PhaseHandler } from "./types.js";

/** Mocked send (decision #3): logs rather than actually dispatching an email. */
function mockSendEmail(partyId: string | undefined, summaryText: string | undefined): void {
  console.log("[MOCK EMAIL] Sending call summary", {
    partyId,
    summary: summaryText ?? "(no summary captured)"
  });
}

// Reached on the turn after PROCESS_CASE has already asked "would you like
// this emailed?" (state.postProcess.emailOffered). Interprets the caller's
// yes/skip decision, mock-sends if accepted, and ends the call in the
// terminal DONE state either way (see DECISIONS.md #16).
export const handlePostProcess: PhaseHandler = async ({ state, userMessage }) => {
  const wantsEmail = isAffirmativeResponse(userMessage);

  if (wantsEmail) {
    mockSendEmail(state.identity.partyId, state.postProcess.summaryText);
    state.postProcess.emailDecision = "sent";
    state.phase = "DONE";
    return "Great — I've sent that summary to the email we have on file. Thank you for calling, and take care!";
  }

  state.postProcess.emailDecision = "skipped";
  state.phase = "DONE";
  return "No problem, I won't send an email. Thank you for calling, and take care!";
};
