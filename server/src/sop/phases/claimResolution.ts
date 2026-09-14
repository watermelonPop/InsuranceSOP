import type { LLMClient, LLMMessage } from "../../llm/index.js";
import type { Claim } from "../../tools/fixtures.js";
import type { Emotion } from "../state.js";
import { emotionAcknowledgmentLine } from "./emotionPrompt.js";

/**
 * Scores how well a claim matches remembered hints. Higher is better; 0
 * means the hints gave no signal either way for this claim. Shared between
 * RESOLVE_INTENT's initial resolution and PROCESS_CASE's mid-conversation
 * claim-switch detection (see DECISIONS.md #22) so both use identical logic.
 */
export function scoreClaimForHint(claim: Claim, caseTypeHint?: string, intentHint?: string): number {
  let score = 0;
  if (caseTypeHint && claim.case_type === caseTypeHint) score += 2;

  // Word-variant matching (see DECISIONS.md #38), not exact-substring: the
  // per-turn extractor re-derives intentHint's wording on every turn (e.g.
  // "denied" on one turn, "denial"/"declined" paraphrasing another), and an
  // exact "denied" check missed those synonyms — breaking resolution for
  // the literal spec demo scenario when the caller's follow-up ("why was it
  // denied?") got re-paraphrased as "explain denial of..." instead.
  const hintLower = (intentHint ?? "").toLowerCase();
  if (/\bdeni(ed|al)\b|\bdeclin(ed|e)\b/.test(hintLower) && claim.status === "denied") score += 2;
  if (/\bclos(ed|e)\b/.test(hintLower) && claim.status === "closed") score += 1;
  if (/\bopen(ed|ing)?\b/.test(hintLower) && claim.status === "open") score += 1;
  if (/\bpending\b/.test(hintLower) && claim.status === "pending") score += 1;

  return score;
}

/**
 * Picks the single unambiguous best-matching claim for the given hints out
 * of a caller's claims. Returns undefined when there's no signal or a tie
 * among the top scorers — callers should ask a clarifying question instead
 * of guessing.
 */
export function pickBestClaim(claims: Claim[], caseTypeHint?: string, intentHint?: string): Claim | undefined {
  if (claims.length === 1) return claims[0];

  const scored = claims
    .map((claim) => ({ claim, score: scoreClaimForHint(claim, caseTypeHint, intentHint) }))
    .sort((a, b) => b.score - a.score);

  const topScore = scored[0]?.score ?? 0;
  const tiedForTop = scored.filter((s) => s.score === topScore);

  if (topScore > 0 && tiedForTop.length === 1) {
    return tiedForTop[0].claim;
  }
  return undefined;
}

/** Asks a grounded clarifying question listing the caller's real claims, without resolving to any of them. */
export async function askWhichClaim(params: {
  claims: Claim[];
  userMessage: string;
  emotion: Emotion;
  contextMessages: LLMMessage[];
  llm: LLMClient;
}): Promise<string> {
  const claimOptionsForPrompt = params.claims.map((c) => `- a ${c.case_type} claim, status: ${c.status}`).join("\n");
  const emotionLine = emotionAcknowledgmentLine(params.emotion);

  const reply = await params.llm.complete({
    system: [
      "You are a warm, conversational insurance claims support agent. The caller is already verified — that happened earlier in this call and is done. NEVER ask them to re-confirm their name, date of birth, SSN/ID, phone, email, or any other identity detail, and never imply verification is incomplete.",
      "You cannot yet tell which of their claims they mean. Here is their ACTUAL claim list (grounded — never invent any other claim or detail beyond this):",
      claimOptionsForPrompt,
      "Ask a brief clarifying question so you can tell which one they mean, using ONLY case type or status (e.g. \"is this about your auto claim or one of your healthcare claims?\") — never ask for a claim number, case ID, or date of service; the caller doesn't necessarily have those handy and you don't need them, the list above is everything you have. Do not state any denial reasons, amounts, or other specifics yet.",
      emotionLine,
      "Keep it to 1-3 sentences."
    ]
      .filter(Boolean)
      .join("\n"),
    temperature: 0.5,
    maxOutputTokens: 600,
    messages: [...params.contextMessages, { role: "user", content: params.userMessage }]
  });
  return reply.trim();
}
