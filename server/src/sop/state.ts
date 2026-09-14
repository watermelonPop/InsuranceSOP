import type { LLMMessage } from "../llm/index.js";
import type { IdentityFieldKey } from "../tools/identity.js";

export type Phase = "VERIFY_ID" | "RESOLVE_INTENT" | "PROCESS_CASE" | "POST_PROCESS" | "ESCALATED" | "DONE";

export type Emotion = "neutral" | "frustrated" | "anxious" | "angry" | "confused" | "refusing";

export interface IdentityProgress {
  claimed: {
    name?: string;
    dob?: string;
    phone?: string;
    email?: string;
    idLast4?: string;
  };
  matchedFields: IdentityFieldKey[];
  verified: boolean;
  partyId?: string;
  /** Consecutive VERIFY_ID turns with no newly-matched field — drives the "stop persuading, offer human" cutoff. */
  noProgressStreak?: number;
  /** Set once the caller indicates they're calling on someone else's behalf (see DECISIONS.md #23). */
  callerRole?: "policyholder" | "representative";
  /** The representative caller's own stated name, distinct from the policyholder identity fields in `claimed`. */
  representativeName?: string;
  /** True once a representative call has passed both the rep-authorization and consent checks. */
  representativeAuthorized?: boolean;
}

/**
 * Facts picked up from the caller at any point in the conversation, regardless
 * of which phase they were said in — e.g. an intent/case hint volunteered
 * during VERIFY_ID, to be used once RESOLVE_INTENT is reached instead of
 * re-asking from scratch.
 */
export interface ConversationMemory {
  intentHint?: string;
  caseTypeHint?: string;
  caseIdHint?: string;
}

export interface ConversationState {
  phase: Phase;
  identity: IdentityProgress;
  memory: ConversationMemory;
  lastEmotion: Emotion;
  offTopicStreak: number;
  escalationOffered: boolean;
  /** True for exactly one turn after a human-transfer offer, so the next reply can be checked for acceptance. */
  humanTransferOffered: boolean;
  historyForLLM: LLMMessage[];
  resolvedCaseId?: string;
  /** True for exactly one turn after resolvedCaseId is newly set/switched, so PROCESS_CASE briefly confirms which claim it found before diving into the answer. */
  claimJustResolved?: boolean;
  /** Every claim actually discussed this call (first-discussed order, deduped) — used so the POST_PROCESS summary covers everything discussed, not just whichever claim happened to be resolved last (see DECISIONS.md #27). */
  discussedCaseIds: string[];
  /** Consecutive PROCESS_CASE turns since the last wrap-up check-in (or since entering the phase) — drives the soft wrap-up-or-continue prompt. */
  processCaseTurnCount: number;
  /** True for exactly one turn after the wrap-up check-in question was asked, so the next reply can be interpreted as answering it. */
  wrapUpCheckInPending: boolean;
  postProcess: {
    emailOffered: boolean;
    emailDecision?: "sent" | "skipped";
    /** The wrap-up summary text generated when entering POST_PROCESS — reused as the mock email body if the caller accepts. */
    summaryText?: string;
  };
}

export function createInitialState(): ConversationState {
  return {
    phase: "VERIFY_ID",
    identity: {
      claimed: {},
      matchedFields: [],
      verified: false
    },
    memory: {},
    lastEmotion: "neutral",
    offTopicStreak: 0,
    escalationOffered: false,
    humanTransferOffered: false,
    historyForLLM: [],
    discussedCaseIds: [],
    processCaseTurnCount: 0,
    wrapUpCheckInPending: false,
    postProcess: {
      emailOffered: false
    }
  };
}
