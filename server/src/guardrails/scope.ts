import type { ConversationState } from "../sop/state.js";

const OFF_TOPIC_STREAK_FOR_ESCALATION = 2; // see DECISIONS.md: out-of-scope retry threshold

export interface ScopeGuardrailResult {
  blocked: boolean;
  reply?: string;
}

/**
 * Enforces the in-scope-only rule. Applies in every phase (identity
 * verification does not exempt off-topic questions). Mutates the
 * conversation's off-topic streak and offers human escalation once the
 * threshold is hit.
 */
export function applyScopeGuardrail(state: ConversationState, inScope: boolean): ScopeGuardrailResult {
  if (inScope) {
    state.offTopicStreak = 0;
    return { blocked: false };
  }

  state.offTopicStreak += 1;

  if (state.offTopicStreak >= OFF_TOPIC_STREAK_FOR_ESCALATION) {
    state.escalationOffered = true;
    state.humanTransferOffered = true;
    return {
      blocked: true,
      reply:
        "I want to make sure I'm actually helping you — I can only assist with your insurance policy or claim here, so I'm not able to answer that. Would you like me to transfer you to a human representative, or shall we continue with your claim?"
    };
  }

  return {
    blocked: true,
    reply:
      "I'm only able to help with questions about your insurance policy or claim on this line, so I can't answer that one. Is there something about your claim or policy I can help with?"
  };
}
