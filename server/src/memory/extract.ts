import type { LLMClient } from "../llm/index.js";
import type { Emotion } from "../sop/state.js";

export interface TurnAnalysis {
  pii: {
    name: string | null;
    dob: string | null;
    phone: string | null;
    email: string | null;
    idLast4: string | null;
  };
  intentHint: string | null;
  caseTypeHint: string | null;
  emotion: Emotion;
  inScope: boolean;
  callerRole: "policyholder" | "representative" | null;
  representativeName: string | null;
}

const EXTRACTION_SYSTEM_PROMPT = `You analyze a single caller message to an insurance claims support agent.
Extract structured signals from ONLY the latest caller message (use prior turns as context, not as the source of new facts).
Respond with ONLY a JSON object, no prose, matching exactly this shape:

{
  "pii": {
    "name": string or null,       // the POLICYHOLDER's (account holder's) full name, if stated this turn
    "dob": string or null,        // the POLICYHOLDER's date of birth, normalized to YYYY-MM-DD if possible, else as stated
    "phone": string or null,      // the POLICYHOLDER's phone number, digits as stated
    "email": string or null,      // the POLICYHOLDER's email address, if stated
    "idLast4": string or null     // the POLICYHOLDER's last 4 digits of SSN or other ID, if stated
  },
  "intentHint": string or null,   // short paraphrase of what the caller wants help with, e.g. "denied healthcare claim from January", or null if nothing intent-related was said this turn. NEVER describe the act of providing identity/verification info itself (e.g. NOT "providing SSN for verification", NOT "confirming date of birth") as an intentHint — that is not a reason for calling, it's part of verification. A message containing ONLY identity fields (name/DOB/phone/email/SSN) with no separate stated topic must have intentHint: null.
  "caseTypeHint": string or null, // one of "healthcare", "auto", "dental" if inferable, else null
  "emotion": "neutral" | "frustrated" | "anxious" | "angry" | "confused" | "refusing",
  "inScope": boolean,             // false only if the message is about something unrelated to this caller's own insurance claim/policy support (e.g. general trivia, unrelated tech questions, small talk unrelated to the call's purpose)
  "callerRole": "policyholder" | "representative" | null,  // "representative" ONLY if the caller explicitly says they are calling on behalf of someone else (e.g. a family member's account); otherwise null
  "representativeName": string or null  // ONLY the representative caller's OWN name (distinct from the policyholder's name above), if callerRole is "representative" and they stated their own name this turn
}

Rules:
- Only fill a PII field if the caller actually stated that value this turn; leave others null.
- IMPORTANT: if the caller is calling on someone else's behalf (a representative), the "pii" fields above are always about the POLICYHOLDER/account holder being discussed, never the representative's own identity — verification always checks the account holder's identity, even when someone else is calling for them. The representative's own name goes in "representativeName", not "pii.name".
- inScope should be true for anything related to the caller's identity, their claim, policy, documents, process, or reasonable clarifying/emotional remarks about the call itself.
- Do not invent values. Do not include any text outside the JSON object.`;

function safeJsonParse<T>(text: string): T | undefined {
  const trimmed = text.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) return undefined;
  try {
    return JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as T;
  } catch {
    return undefined;
  }
}

const FALLBACK: TurnAnalysis = {
  pii: { name: null, dob: null, phone: null, email: null, idLast4: null },
  intentHint: null,
  caseTypeHint: null,
  emotion: "neutral",
  inScope: true,
  callerRole: null,
  representativeName: null
};

/**
 * Extracts PII/intent/emotion/scope signals from the caller's latest message.
 * Runs regardless of the current phase, so information volunteered early
 * (e.g. an intent hint during VERIFY_ID) is captured for later phases.
 * Falls back to permissive defaults if the LLM's output can't be parsed,
 * so a malformed extraction never itself blocks the caller.
 */
export async function analyzeTurn(
  llm: LLMClient,
  priorTurns: Array<{ role: "user" | "assistant"; content: string }>,
  latestUserMessage: string
): Promise<TurnAnalysis> {
  const contextMessages = priorTurns.slice(-6).map((t) => ({
    role: t.role,
    content: t.content
  }));

  const request = {
    system: EXTRACTION_SYSTEM_PROMPT,
    temperature: 0,
    maxOutputTokens: 900,
    jsonMode: true,
    messages: [...contextMessages, { role: "user" as const, content: latestUserMessage }]
  };

  // The free-tier model occasionally returns malformed/truncated JSON even
  // in JSON mode, or the provider itself throws (e.g. Groq's own JSON-mode
  // validator failing server-side); one retry clears most of these
  // transient cases before we fall back to permissive defaults.
  let parsed: Partial<TurnAnalysis> | undefined;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    let raw: string;
    try {
      raw = await llm.complete(request);
    } catch (err) {
      console.warn(`analyzeTurn: LLM call threw on attempt ${attempt + 1}:`, err);
      continue;
    }
    parsed = safeJsonParse<Partial<TurnAnalysis>>(raw);
    if (!parsed) {
      console.warn(`analyzeTurn: failed to parse LLM output as JSON (attempt ${attempt + 1}). Raw output:`, raw);
    }
  }
  if (!parsed) return FALLBACK;

  return {
    pii: {
      name: parsed.pii?.name ?? null,
      dob: parsed.pii?.dob ?? null,
      phone: parsed.pii?.phone ?? null,
      email: parsed.pii?.email ?? null,
      idLast4: parsed.pii?.idLast4 ?? null
    },
    intentHint: sanitizeIntentHint(parsed.intentHint ?? null),
    caseTypeHint: parsed.caseTypeHint ?? null,
    emotion: parsed.emotion ?? "neutral",
    inScope: parsed.inScope ?? true,
    callerRole: parsed.callerRole ?? null,
    representativeName: parsed.representativeName ?? null
  };
}

/**
 * Deterministic safety net (see DECISIONS.md #37): the prompt already tells
 * the model never to describe providing identity/verification info itself
 * as an intentHint (e.g. "providing SSN for verification" isn't a reason for
 * calling), but this model has repeatedly shown it won't reliably follow a
 * prompt-only instruction on this kind of judgment call. Rather than trust
 * that alone, discard any intentHint that reads as being ABOUT the
 * verification process rather than an actual case topic.
 */
const VERIFICATION_NOISE_INTENT_PATTERN =
  /\b(provid(e|ing)|confirm(ing)?|shar(e|ing|ed)|stat(e|ing|ed))\b[\s\S]{0,40}\b(ssn|id|date of birth|dob|phone( number)?|email( address)?|last (four|4)( digit)?s?)\b|verif(y|ication)/i;

function sanitizeIntentHint(intentHint: string | null): string | null {
  if (!intentHint) return null;
  return VERIFICATION_NOISE_INTENT_PATTERN.test(intentHint) ? null : intentHint;
}
