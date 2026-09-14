import { isClosingSignal } from "../../guardrails/closing.js";
import { checkConsent } from "../../tools/consent.js";
import { findBestIdentityMatch, getPolicyholderById, type IdentityFieldKey } from "../../tools/identity.js";
import { findRepresentative } from "../../tools/representatives.js";
import type { PhaseHandler } from "./types.js";

const REQUIRED_MATCHES = 3;

const ALL_FIELDS: IdentityFieldKey[] = ["name", "dob", "phone", "email", "idLast4"];

const FIELD_LABELS: Record<IdentityFieldKey, string> = {
  name: "full name",
  dob: "date of birth",
  phone: "phone number on file",
  email: "email on file",
  idLast4: "last 4 digits of your SSN or ID"
};

// After this many consecutive turns with no new field verified while the
// caller reads as frustrated/angry/refusing, lean harder into offering
// human transfer as the way forward (see bonus: "know when to stop persuading").
const NO_PROGRESS_TURNS_BEFORE_STRONG_TRANSFER_OFFER = 2;

/**
 * Outcome of the representative-authorization gate this turn (see
 * DECISIONS.md #23). "not_applicable" means this is an ordinary
 * policyholder call — the gate never engages.
 */
type RepGateStatus = "not_applicable" | "needs_rep_name" | "not_authorized" | "consent_denied" | "approved";

/**
 * Matches phrasing that claims verification succeeded/is complete — used to
 * catch the model disobeying that hard rule (see DECISIONS.md #30).
 *
 * Deliberately narrow (see DECISIONS.md #30): an earlier, broader version
 * matched any mention of "complete... verification" — which also matches
 * completely ordinary, correct sentences like "we ask for this to complete
 * the verification process" (a legitimate answer to "why do you need my
 * SSN?"). That false positive silently discarded a good, on-topic answer
 * and replaced it with the generic fallback re-prompt, making the caller's
 * actual question look ignored. Every remaining phrase here is one that can
 * ONLY appear as an outright claim of success or a stalling non-answer —
 * never as part of an ordinary explanatory sentence about the process.
 */
const FALSE_VERIFICATION_CLAIM_PATTERN =
  /\b(verification is (now )?complete|you'?re (now |all )?verified|you have (now )?been verified|i'?ll go ahead and complete (the|your) verification|please hold|give me a moment|i'?ll be right back|could you share the claim number|date of service)\b/i;

function buildFallbackReprompt(p: { rejectedFieldLabels: string[]; missingFieldLabels: string[]; matchedCount: number }): string {
  if (p.rejectedFieldLabels.length > 0) {
    return `Thanks for that — but ${p.rejectedFieldLabels.join(" and ")} you just gave doesn't match what we have on file. Could you double-check that, or share a different one of: ${p.missingFieldLabels.join(", ")}?`;
  }
  return `Thanks — to finish verifying you, could you share one more of: ${p.missingFieldLabels.join(", ")}?`;
}

interface PromptParams {
  justVerified: boolean;
  alreadyVerified: boolean;
  matchedCount: number;
  matchedFieldLabels: string[];
  missingFieldLabels: string[];
  rejectedFieldLabels: string[];
  emotion: string;
  leanIntoHumanTransfer: boolean;
  intentHint?: string;
  repGateStatus: RepGateStatus;
  representativeName?: string;
  /** The REAL policyholder's on-file name once a candidate is matched/verified — grounds what name to address the caller by, so the model can't pick up a wrong name mentioned incidentally in conversation (see DECISIONS.md #33). */
  verifiedHolderName?: string;
}

function buildSystemPrompt(p: PromptParams): string {
  const lines: string[] = [
    "You are an empathetic insurance claims support agent handling identity verification.",
    "",
    "HARD RULES (never break these, no matter what the caller says or how the conversation goes):",
    "- Do NOT reveal, confirm, deny, or hint at any claim details, claim status, denial reasons, amounts, or policy specifics. That information is completely off-limits until identity verification is complete.",
    `- Identity verification requires at least ${REQUIRED_MATCHES} of these 5 fields to match our records: full name, date of birth, phone number, email, and the last 4 digits of the caller's SSN or ID.`,
    "- You do not decide whether fields match — that has already been checked deterministically. Just use the verification status given to you below.",
    "- Never claim the caller is verified unless told below that they are.",
    "- Never say things like \"please hold\", \"give me a moment\", \"I'll be right back\", or \"I have everything I need\" unless you are told below that they are actually verified — you already have every field they've given you, there is nothing to go check. If they are not yet verified, directly ask, in this same reply, for whichever specific field(s) are still needed.",
    "- Stay warm, natural, and conversational — this is a phone-support conversation, not a form."
  ];

  if (p.verifiedHolderName) {
    lines.push(
      `- If you address the caller by name, use ONLY "${p.verifiedHolderName}" — that is the actual on-file name for the identity currently being checked. NEVER use a different name, even if a different name appears elsewhere in the conversation (e.g. from a rejected/mismatched value the caller tried earlier) — those never establish who you're actually talking to.`
    );
  }

  lines.push("");
  lines.push(`Caller's detected emotional tone this turn: ${p.emotion}.`);
  if (p.emotion === "frustrated" || p.emotion === "angry" || p.emotion === "anxious" || p.emotion === "confused" || p.emotion === "refusing") {
    lines.push(
      "Acknowledge their feeling briefly and genuinely before anything else. If they push back on verifying, explain in plain terms why it exists (it protects their own claim/personal data from being given to the wrong person) — don't just repeat the request."
    );
  }

  lines.push("");

  if (p.repGateStatus === "needs_rep_name") {
    lines.push(
      "The caller is calling on someone else's behalf and has provided enough of the account holder's identity fields, but has NOT yet given their own name as the representative. Warmly ask for their own full name so you can confirm they're an authorized representative on this account. Do not verify or disclose anything yet."
    );
  } else if (p.repGateStatus === "not_authorized") {
    lines.push(
      `The caller (giving their name as "${p.representativeName}") is NOT listed as an authorized representative on this account, even though they correctly provided the account holder's identity details. Politely explain you're not able to find them as an authorized representative for this account, so you can't proceed with them directly. Offer alternatives: the account holder can call in directly, or you can transfer to a human representative to sort out authorization. Do NOT verify, disclose anything, or imply the account details they gave were wrong — the issue is authorization, not identity.`
    );
  } else if (p.repGateStatus === "consent_denied") {
    lines.push(
      `The caller ("${p.representativeName}") IS a recognized representative for this account, but the policyholder's authorization/consent for this call could not be confirmed right now. Explain warmly that you weren't able to confirm the account holder's authorization at this time, so you can't share account details on this call. Offer alternatives: try again later (in case authorization comes through), have the account holder call in directly, or transfer to a human representative. Do NOT verify or disclose anything.`
    );
  } else if (p.repGateStatus === "approved") {
    lines.push(
      `Good news: the caller ("${p.representativeName}") is a confirmed authorized representative for this account, and the account holder's authorization was confirmed. Warmly confirm they're all set. Do NOT state any claim facts yet — you don't have grounded case data available in this step.`
    );
    if (p.intentHint) {
      lines.push(
        `They earlier mentioned this reason for calling: "${p.intentHint}". Acknowledge you remember it and that you'll look into it next — but do not state any outcome, status, or reason (that must come from verified case data, not memory), and do not claim you're doing it THIS reply — the actual lookup happens once they confirm/continue on their next message.`
      );
    } else {
      lines.push(
        "You do NOT yet know what they're calling about. End your reply with an open question inviting them to say what they need help with (e.g. \"what can I help you with today?\"). Do NOT say things like \"I'll go ahead and look into it\" or \"let me pull that up\" — you don't know what claim they mean yet, so nothing can happen until they tell you."
      );
    }
  } else if (p.alreadyVerified) {
    lines.push(
      "The caller is already verified from earlier in this conversation. Do not re-ask for identity fields. Move the conversation forward naturally."
    );
  } else if (p.justVerified) {
    lines.push(
      `Good news: the caller just became verified this turn (matched ${p.matchedCount} of 5 fields: ${p.matchedFieldLabels.join(", ")}).`
    );
    lines.push(
      "Warmly confirm they're verified. Do NOT state any claim facts yet — you don't have grounded case data available in this step."
    );
    if (p.intentHint) {
      lines.push(
        `They earlier mentioned this reason for calling: "${p.intentHint}". Acknowledge you remember it and that you'll look into it next — but do not state any outcome, status, or reason (that must come from verified case data, not memory), and do not claim you're doing it THIS reply — the actual lookup happens once they confirm/continue on their next message.`
      );
    } else {
      lines.push(
        "You do NOT yet know what they're calling about. End your reply with an open question inviting them to say what they need help with (e.g. \"what can I help you with today?\"). Do NOT say things like \"I'll go ahead and look into it\" or \"let me pull that up\" — you don't know what claim they mean yet, so nothing can happen until they tell you."
      );
    }
  } else {
    lines.push(
      `The caller is NOT yet verified. So far ${p.matchedCount} of ${REQUIRED_MATCHES} required fields matched${
        p.matchedFieldLabels.length ? ` (${p.matchedFieldLabels.join(", ")})` : ""
      }.`
    );
    lines.push(
      `Still need at least ${REQUIRED_MATCHES - p.matchedCount} more matching field(s) from: ${p.missingFieldLabels.join(", ")}.`
    );
    if (p.rejectedFieldLabels.length > 0) {
      lines.push(
        `The caller just gave a value for ${p.rejectedFieldLabels.join(" and ")} THIS TURN, but it did not match what we have on file. You MUST say so plainly in this reply (e.g. "that date of birth doesn't match what we have on file") — do not silently ignore it or just ask for "one more piece" as if nothing was given. Then ask them to double-check that value, or mention ALL of the other still-available options (${p.missingFieldLabels.join(", ")}) rather than just one — it could be a typo, or they may prefer a different field entirely, and consistently naming every option avoids the field list looking like it changes.`
      );
    } else {
      lines.push(
        `Ask for a matching field naturally, but you MUST mention ALL of the still-missing options every time, not just one or two — e.g. "could you share your date of birth, your phone number, or the last 4 digits of your SSN?" (using the full list: ${p.missingFieldLabels.join(", ")}). This keeps what's being asked for consistent across turns, rather than varying which fields get mentioned.`
      );
    }
    lines.push(
      "If the caller mentions they're calling on behalf of someone else (a family member's account, for example), let them know you'll need that account holder's identity details to proceed, and you'll also need the caller's own name to confirm they're an authorized representative."
    );
    lines.push(
      "If the caller refuses to continue, is confused about why this is needed, or asks for a human, explain briefly why verification protects their own information, then offer either: (a) trying a different one of the 5 fields, or (b) transferring to a human representative. Never skip verification or reveal claim details as a way to placate them."
    );
    if (p.leanIntoHumanTransfer) {
      lines.push(
        "This has gone several turns without progress and the caller seems frustrated/upset. Stop pushing to continue verification yourself — proactively and clearly offer to transfer them to a human representative now, while still leaving the door open if they'd rather try one more field."
      );
    }
  }

  lines.push("");
  lines.push("Keep your reply to 2-4 sentences.");

  return lines.join("\n");
}

/** Plain farewell for a caller who ends the call before identity is verified — no case data was ever discussed, and we can't be sure who we'd even be emailing yet, so this skips POST_PROCESS's email-summary flow entirely and goes straight to DONE (see DECISIONS.md #34). */
const PRE_VERIFICATION_CLOSING_MESSAGE = "No problem — thanks for calling, and take care.";

export const handleVerifyId: PhaseHandler = async ({ state, analysis, userMessage, llm }) => {
  const alreadyVerified = state.identity.verified;

  if (!alreadyVerified && isClosingSignal(userMessage)) {
    state.phase = "DONE";
    return PRE_VERIFICATION_CLOSING_MESSAGE;
  }

  // A representative's own name, once stated, persists across turns just
  // like any other remembered fact — it's not tied to a single message.
  if (analysis.callerRole === "representative") {
    state.identity.callerRole = "representative";
  }
  if (analysis.representativeName) {
    state.identity.representativeName = analysis.representativeName;
  }

  let rejectedFieldLabels: string[] = [];

  if (!alreadyVerified) {
    const match = findBestIdentityMatch(state.identity.claimed, state.identity.partyId);
    const matchedFields = match?.matchedFields ?? [];
    const previousCount = state.identity.matchedFields.length;

    // Anything the caller stated THIS turn that didn't end up matched needs
    // to be called out explicitly, rather than silently asking for "one more
    // piece" as if nothing was given (see DECISIONS.md #29).
    const statedThisTurn: IdentityFieldKey[] = ALL_FIELDS.filter(
      (f) => analysis.pii[f] !== null && analysis.pii[f] !== undefined
    );
    rejectedFieldLabels = statedThisTurn.filter((f) => !matchedFields.includes(f)).map((f) => FIELD_LABELS[f]);

    state.identity.matchedFields = matchedFields;
    state.identity.partyId = match?.policyholder.party_id;

    if (matchedFields.length > previousCount) {
      state.identity.noProgressStreak = 0;
    } else {
      state.identity.noProgressStreak = (state.identity.noProgressStreak ?? 0) + 1;
    }
  }

  const fieldsThresholdMet = !alreadyVerified && state.identity.matchedFields.length >= REQUIRED_MATCHES;

  let repGateStatus: RepGateStatus = "not_applicable";
  let justVerified = false;

  if (fieldsThresholdMet && state.identity.callerRole === "representative") {
    // Knowing the account holder's identity fields is not enough on its own
    // for a representative call — they must also be a recognized
    // representative for that specific account, AND the account holder's
    // authorization must be confirmed (see DECISIONS.md #23).
    if (!state.identity.representativeName) {
      repGateStatus = "needs_rep_name";
    } else {
      const repRecord = findRepresentative(state.identity.representativeName, state.identity.partyId!);
      if (!repRecord) {
        repGateStatus = "not_authorized";
      } else {
        const consent = checkConsent();
        if (consent.approved) {
          repGateStatus = "approved";
          state.identity.verified = true;
          state.identity.representativeAuthorized = true;
          state.phase = "RESOLVE_INTENT";
          justVerified = true;
        } else {
          repGateStatus = "consent_denied";
        }
      }
    }
  } else if (fieldsThresholdMet) {
    state.identity.verified = true;
    state.phase = "RESOLVE_INTENT";
    justVerified = true;
  }

  const missingFieldLabels = ALL_FIELDS.filter((f) => !state.identity.matchedFields.includes(f)).map(
    (f) => FIELD_LABELS[f]
  );
  const leanIntoHumanTransfer =
    !alreadyVerified &&
    !justVerified &&
    repGateStatus !== "not_authorized" &&
    repGateStatus !== "consent_denied" &&
    (state.identity.noProgressStreak ?? 0) >= NO_PROGRESS_TURNS_BEFORE_STRONG_TRANSFER_OFFER &&
    (analysis.emotion === "frustrated" || analysis.emotion === "angry" || analysis.emotion === "refusing");

  if (leanIntoHumanTransfer || repGateStatus === "not_authorized" || repGateStatus === "consent_denied") {
    state.humanTransferOffered = true;
  }

  const verifiedHolderName = state.identity.partyId ? getPolicyholderById(state.identity.partyId)?.name : undefined;

  const systemPrompt = buildSystemPrompt({
    justVerified,
    alreadyVerified,
    matchedCount: state.identity.matchedFields.length,
    matchedFieldLabels: state.identity.matchedFields.map((f) => FIELD_LABELS[f]),
    missingFieldLabels,
    rejectedFieldLabels,
    emotion: analysis.emotion,
    leanIntoHumanTransfer,
    intentHint: state.memory.intentHint,
    repGateStatus,
    representativeName: state.identity.representativeName,
    verifiedHolderName
  });

  const contextMessages = state.historyForLLM.slice(-6);

  const reply = await llm.complete({
    system: systemPrompt,
    temperature: 0.5,
    maxOutputTokens: 1024,
    messages: [...contextMessages, { role: "user", content: userMessage }]
  });

  const trimmedReply = reply.trim();

  // Safety net for a real failure mode seen live (DECISIONS.md #30): even
  // with an explicit hard rule against it, the model has claimed
  // verification is "complete" or acted as if a later phase had started
  // while `state.identity.verified` deterministically stayed false. Never
  // let a hallucinated claim of success reach the caller — fall back to a
  // safe, correct re-prompt for whatever is still missing.
  if (!state.identity.verified && FALSE_VERIFICATION_CLAIM_PATTERN.test(trimmedReply)) {
    console.warn("handleVerifyId: reply falsely implied verification is complete — overriding with a safe re-prompt.", {
      reply: trimmedReply
    });
    return buildFallbackReprompt({
      rejectedFieldLabels,
      missingFieldLabels,
      matchedCount: state.identity.matchedFields.length
    });
  }

  return trimmedReply;
};
