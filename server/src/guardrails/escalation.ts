export const ESCALATION_HANDOFF_MESSAGE =
  "Connecting you to a human representative now — this chat session will end here. Thank you for your patience.";

/**
 * Cheap deterministic check for whether a caller accepted a just-made human-
 * transfer offer. Deliberately simple (no LLM call) since this gates a
 * terminal state transition and should be predictable, not interpretive.
 */
export function isAffirmativeResponse(message: string): boolean {
  const m = message.trim().toLowerCase();
  if (/\bno\b/.test(m) && !/\byes\b/.test(m)) return false;
  return /\b(yes|yeah|yep|yup|sure|okay|ok|please|go ahead|transfer me|connect me)\b/.test(m);
}
