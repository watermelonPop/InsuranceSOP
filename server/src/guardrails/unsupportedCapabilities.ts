export const REPRESENTATIVE_ENROLLMENT_NOT_SUPPORTED_MESSAGE =
  "I'm not able to add or change authorized representatives on an account through this chat, for security reasons — that has to go through a human representative. Would you like me to connect you with one now?";

/**
 * Detects a caller trying to ENROLL/authorize a NEW representative on their
 * account (e.g. "give access to my son", "consent to a family member as a
 * representative") — a capability this system does not actually support.
 * `fixtures/representatives.json` is a static, read-only list checked only
 * when a representative calls in (decision #25); there is no write/enrollment
 * path anywhere in the system.
 *
 * Caught deterministically, before the request ever reaches the LLM, because
 * live testing showed the model fabricating an entire fake data-collection
 * flow for this instead of saying it couldn't help — including asking to
 * collect a third party's SSN for a "feature" that doesn't exist (see
 * DECISIONS.md #28). This is the same category of risk as the earlier
 * fabricated-contact-info bug (decision #14): the fix there was grounding
 * facts the model could still misuse; here there's no fact-grounding that
 * would help at all, since the entire capability is imaginary — the request
 * has to be blocked before generation, not corrected after.
 */
// Deliberately excludes generic pronouns (him/her/them) — those are too
// prone to false-matching unrelated sentences ("add a note about her
// claim"). Explicit relationship/representative nouns keep this precise.
const RELATED_PARTY_WORDS =
  "representative|rep|family member|someone|son|daughter|husband|wife|spouse|mother|father|parent|brother|sister|child";

export function isRepresentativeEnrollmentRequest(message: string): boolean {
  const m = message.toLowerCase();
  const nearbyRelatedParty = new RegExp(`\\b(add|authorize)\\b[\\s\\S]{0,40}\\b(${RELATED_PARTY_WORDS})\\b`);
  return (
    /\bgive access\b/.test(m) ||
    /\bgrant\b[\s\S]{0,40}\baccess\b/.test(m) ||
    nearbyRelatedParty.test(m) ||
    /\bconsent to\b[\s\S]{0,40}\b(representative|family member)\b/.test(m) ||
    /\b(call in|calling in)\b[\s\S]{0,20}\bon my behalf\b/.test(m)
  );
}
