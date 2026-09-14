import { isAffirmativeResponse } from "../../guardrails/escalation.js";
import { isClosingSignal } from "../../guardrails/closing.js";
import { getClaim, getClaimsForParty } from "../../tools/claims.js";
import type { Claim } from "../../tools/fixtures.js";
import {
  findFollowupGuidance,
  getAlternativeGuidance,
  getHumanReviewGuidance,
  getSubmissionGuidance
} from "../../tools/documentGuidance.js";
import type { Emotion } from "../state.js";
import { askWhichClaim, pickBestClaim } from "./claimResolution.js";
import { emotionAcknowledgmentLine } from "./emotionPrompt.js";
import type { LLMClient, LLMMessage } from "../../llm/index.js";
import type { PhaseHandler } from "./types.js";

type FollowupTopic = "document_submission" | "next_steps" | "denial_question" | "general_claim_question" | "status_inquiry";

/** Cheap keyword classification into the topic buckets used by claim_followup_guidance — no LLM call needed. */
function classifyTopic(userMessage: string): FollowupTopic {
  const m = userMessage.toLowerCase();
  if (/why|denied|denial|reason/.test(m)) return "denial_question";
  if (/submit|upload|send|portal|document|photo|scan|pdf|format/.test(m)) return "document_submission";
  if (/status|update|where is|progress/.test(m)) return "status_inquiry";
  if (/next|what now|what should i do|steps/.test(m)) return "next_steps";
  return "general_claim_question";
}

function buildGroundedFacts(claim: Claim, topic: FollowupTopic, userMessage: string): string[] {
  const documentsNeeded = claim.documents_needed ?? [];

  const facts: string[] = [
    `Case ID: ${claim.case_id}`,
    `Case type: ${claim.case_type}`,
    `Status: ${claim.status}`,
    `Summary: ${claim.summary}`,
    `Expected reimbursement amount: $${claim.expected_reimbursement_amount}`,
    `Allowed max amount: $${claim.allowed_max_amount}`,
    `Net pay so far: $${claim.net_pay}`
  ];
  if (claim.denial_reason) facts.push(`Denial reason: ${claim.denial_reason}`);
  if (claim.appeal_deadline) facts.push(`Appeal deadline: ${claim.appeal_deadline}`);

  if (documentsNeeded.length > 0) {
    facts.push(`Documents needed: ${documentsNeeded.join(", ")}`);
    facts.push(`Submission guidance: ${getSubmissionGuidance(claim.case_type, documentsNeeded).join(" ")}`);
    for (const doc of documentsNeeded) {
      facts.push(`If "${doc}" isn't available: ${getAlternativeGuidance(doc)}`);
    }
    facts.push(
      `Guidance most relevant to the caller's current question: ${findFollowupGuidance({
        caseId: claim.case_id,
        documentsNeeded,
        intentHint: topic,
        utterance: userMessage
      })}`
    );
    facts.push(`If all reasonable alternatives are exhausted: ${getHumanReviewGuidance()}`);
  }

  return facts;
}

const BASE_RULES = [
  "You are a warm, conversational insurance claims support agent. The caller is verified and you have already identified their claim.",
  "Answer ONLY using the grounded facts below — never invent a status, amount, reason, or requirement that isn't listed here. If the caller asks something these facts don't cover, say you're not sure and offer to connect them with a human representative rather than guessing.",
  "All the facts you need are already given to you below — you have ALREADY looked up the claim. Never say things like \"let me pull that up\", \"give me a moment\", \"could you share the claim number\", \"could you tell me the date of service\", or \"I'll get back to you\" — you already have the claim identified (see Case ID below); answer directly, right now, in this reply, using only the facts given.",
  "CRITICAL: the caller's identity is ALREADY fully verified — that happened earlier in this call and is done. NEVER ask them to re-confirm their name, date of birth, SSN/ID, phone, email, or any other identity detail, and never say anything implying verification is incomplete or needs to happen again.",
  "CRITICAL: never invent a specific email address, fax number, phone number, mailing address, or URL — none are provided below because none exist in this system. If the caller needs one of those, say a human representative or the member portal can provide it, and offer to connect them, rather than making one up."
];

interface WrapUpParams {
  /** Every claim actually discussed this call — not just the currently-resolved one — so the summary can cover all of them. */
  discussedClaims: Claim[];
  emotion: Emotion;
  userMessage: string;
  contextMessages: LLMMessage[];
  llm: LLMClient;
}

const EMAIL_QUESTION = "Would you like me to email you a summary of this call, or would you prefer to skip that?";
const FALLBACK_WRAP_UP_OPENING = "Thanks for calling today — here's a quick recap of everything we covered:";

/** One deterministic, always-correct recap line per claim — see DECISIONS.md #27 for why this isn't left to the model. */
function summarizeClaimForWrapUp(claim: Claim): string {
  const label = `Your ${claim.case_type} claim (${claim.case_id})`;

  if (claim.status === "denied") {
    const reasonPart = claim.denial_reason ? ` because ${claim.denial_reason}` : "";
    const documentsNeeded = claim.documents_needed ?? [];
    const docsPart =
      documentsNeeded.length > 0
        ? ` To move forward, please submit: ${documentsNeeded.join(", ")} — online through the member portal, or by fax/mail if you'd rather not upload them (just let us know and we'll arrange that).`
        : "";
    const deadlinePart = claim.appeal_deadline ? ` The appeal deadline is ${claim.appeal_deadline}.` : "";
    return `${label} was denied${reasonPart}.${docsPart}${deadlinePart}`;
  }
  if (claim.status === "closed") {
    return `${label} is closed and was settled with a net payment of $${claim.net_pay} (allowed max $${claim.allowed_max_amount}) — no further action needed.`;
  }
  if (claim.status === "open") {
    return `${label} is still open and in progress; expected reimbursement is $${claim.expected_reimbursement_amount}.`;
  }
  return `${label} status: ${claim.status}.`;
}

/**
 * Generates the end-of-call summary + email-consent ask.
 *
 * The substantive facts (status/outcome/next-steps for every claim
 * discussed) are computed deterministically first — see
 * `summarizeClaimForWrapUp` — because live testing showed the model
 * repeatedly failing to produce a correct recap even with explicit
 * instructions (decisions #26, #28). But a fully static recap loses real
 * value: it can't reflect what the caller actually asked about that call
 * (decision #30). So this asks the LLM to weave the deterministic facts
 * into a natural recap — free to also reference specific things discussed
 * in the conversation — but then VALIDATES the result actually still
 * contains every required fact before trusting it. If the model dropped or
 * altered anything (or the call failed outright), falls back to the plain
 * deterministic recap, which is always correct even if less natural. This
 * generate-then-validate-then-fallback pattern is the same shape as
 * `analyzeTurn`'s retry/fallback handling (decision #8) — never let an
 * unreliable model output override a guaranteed-correct one.
 */
async function generateWrapUp(params: WrapUpParams): Promise<string> {
  const claims = params.discussedClaims;
  const recapLines = claims.map((c) => `- ${summarizeClaimForWrapUp(c)}`);
  const deterministicRecap = [FALLBACK_WRAP_UP_OPENING, ...recapLines, EMAIL_QUESTION].join("\n");

  if (claims.length === 0) return deterministicRecap;

  const enrichSystemPrompt = [
    "You are a warm, conversational insurance claims support agent wrapping up a call.",
    emotionAcknowledgmentLine(params.emotion),
    "Below are the FINAL, pre-approved facts for this call's summary. Weave them into ONE warm, natural closing recap message.",
    "HARD RULES:",
    "- You MUST include every fact below, accurately and completely — never omit, shorten away, or alter any case ID, amount, date, document name, or status.",
    "- You MAY additionally, naturally reference something specific the caller asked about earlier in this conversation, if it's directly relevant to one of the claims below — but never invent a fact you weren't given.",
    "- Do NOT ask about emailing a summary — that will be handled separately, after your reply.",
    "",
    "PRE-APPROVED FACTS TO INCLUDE (every one, verbatim details preserved):",
    ...recapLines,
    "",
    "Keep it natural and warm, a few sentences."
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const raw = await params.llm.complete({
      system: enrichSystemPrompt,
      temperature: 0.4,
      maxOutputTokens: 600,
      messages: [...params.contextMessages, { role: "user", content: params.userMessage }]
    });
    const enriched = raw.trim();
    const coversEveryClaim = claims.every((c) => enriched.includes(c.case_id));

    if (enriched && coversEveryClaim) {
      return `${enriched}\n\n${EMAIL_QUESTION}`;
    }
    console.warn("generateWrapUp: enriched recap missing a claim id (or empty) — falling back to deterministic recap.", {
      enriched
    });
  } catch (err) {
    console.warn("generateWrapUp: enrichment LLM call failed — falling back to deterministic recap:", err);
  }

  return deterministicRecap;
}

// Soft safety net (see DECISIONS.md #17): rather than forcing a hard cutoff
// that could truncate a caller with many legitimate questions, once a
// conversation runs long the agent asks whether to wrap up or keep going.
// Declining resets the counter, so the check-in can recur but never forces
// an end the caller hasn't agreed to.
const TURNS_BEFORE_WRAP_UP_CHECKIN = 4;

export const handleProcessCase: PhaseHandler = async ({ state, analysis, userMessage, llm }) => {
  const caseId = state.resolvedCaseId;
  if (!caseId) {
    // Shouldn't happen given the RESOLVE_INTENT -> PROCESS_CASE contract, but fail safe.
    state.phase = "RESOLVE_INTENT";
    return "Let's back up a moment — which claim were you calling about?";
  }

  let claim = getClaim(caseId);
  if (!claim) {
    return "I'm having trouble pulling up that claim right now. Let me connect you with a human representative who can look into this.";
  }

  const contextMessages = state.historyForLLM.slice(-8);

  // Claim-switching (see DECISIONS.md #22): if the caller's remembered
  // case-type hint now points to a different claim than the one currently
  // resolved (e.g. "what about my dental claim instead?"), re-resolve rather
  // than silently keep answering from the stale claim's grounded facts.
  const switchHint = state.memory.caseTypeHint;
  if (switchHint && switchHint !== claim.case_type && state.identity.partyId) {
    const allClaims = getClaimsForParty(state.identity.partyId);
    const matchingType = allClaims.filter((c) => c.case_type === switchHint);

    if (matchingType.length === 1) {
      claim = matchingType[0];
      state.resolvedCaseId = claim.case_id;
      state.processCaseTurnCount = 0; // fresh check-in window for the newly-switched claim
      state.claimJustResolved = true;
    } else if (matchingType.length > 1) {
      const best = pickBestClaim(matchingType, switchHint, state.memory.intentHint);
      if (best) {
        claim = best;
        state.resolvedCaseId = claim.case_id;
        state.processCaseTurnCount = 0;
        state.claimJustResolved = true;
      } else {
        // Ambiguous even among the new type — ask rather than guess which one.
        state.phase = "RESOLVE_INTENT";
        state.resolvedCaseId = undefined;
        return askWhichClaim({ claims: allClaims, userMessage, emotion: analysis.emotion, contextMessages, llm });
      }
    }
    // matchingType.length === 0: caller doesn't actually have that claim type — proceed unchanged.
  }

  // Track every claim actually discussed, regardless of which resolution
  // path got us here, so a later POST_PROCESS summary can cover all of them.
  if (!state.discussedCaseIds.includes(claim.case_id)) {
    state.discussedCaseIds.push(claim.case_id);
  }

  const discussedClaims = state.discussedCaseIds.map((id) => getClaim(id)).filter((c): c is Claim => Boolean(c));

  // A pending check-in from the previous turn: this message is the caller's
  // answer to "wrap up now, or keep going?", not necessarily a new question.
  if (state.wrapUpCheckInPending) {
    state.wrapUpCheckInPending = false;
    const wantsToWrapUp = isAffirmativeResponse(userMessage) || isClosingSignal(userMessage);

    if (wantsToWrapUp) {
      const summary = await generateWrapUp({ discussedClaims, emotion: analysis.emotion, userMessage, contextMessages, llm });
      state.phase = "POST_PROCESS";
      state.postProcess.emailOffered = true;
      state.postProcess.summaryText = summary;
      return summary;
    }

    // Caller wants to keep going — reset the window and fall through to
    // answer this message normally (it may itself contain their next question).
    state.processCaseTurnCount = 0;
  }

  if (isClosingSignal(userMessage)) {
    const summary = await generateWrapUp({ discussedClaims, emotion: analysis.emotion, userMessage, contextMessages, llm });
    state.phase = "POST_PROCESS";
    state.postProcess.emailOffered = true;
    state.postProcess.summaryText = summary;
    return summary;
  }

  state.processCaseTurnCount += 1;
  const shouldCheckIn = state.processCaseTurnCount >= TURNS_BEFORE_WRAP_UP_CHECKIN;

  // Consume the "just resolved/switched" flag: on this first answer for the
  // claim, briefly confirm which one was found before diving into details —
  // otherwise a vague opener like "I need help with a claim" can jump
  // straight into specifics without ever having confirmed which claim (see
  // DECISIONS.md #24).
  const justResolved = state.claimJustResolved ?? false;
  state.claimJustResolved = false;

  const topic = classifyTopic(userMessage);
  const groundedFacts = buildGroundedFacts(claim, topic, userMessage);

  const systemPrompt = [
    ...BASE_RULES,
    "",
    "GROUNDED FACTS FOR THIS CLAIM:",
    ...groundedFacts,
    "",
    emotionAcknowledgmentLine(analysis.emotion),
    justResolved
      ? "This is the first reply addressing this specific claim in the conversation — briefly confirm which claim you found (case type and status) in one short clause before answering."
      : undefined,
    "Answer the caller's question using only the grounded facts above.",
    shouldCheckIn
      ? "After answering, separately ask a clear yes/no question: \"Would you like me to wrap up this call with a summary now, or do you have more questions?\" Phrase it so a plain \"yes\" clearly means wrap up now."
      : undefined,
    "Be conversational, not a data dump. Keep it to 2-5 sentences unless listing documents."
  ]
    .filter(Boolean)
    .join("\n");

  const reply = await llm.complete({
    system: systemPrompt,
    temperature: 0.4,
    maxOutputTokens: 700,
    messages: [...contextMessages, { role: "user", content: userMessage }]
  });

  const trimmedReply = reply.trim();

  if (shouldCheckIn) {
    state.wrapUpCheckInPending = true;
  }

  return trimmedReply;
};
