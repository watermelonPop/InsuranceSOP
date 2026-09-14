import { loadPolicyholders, type Policyholder } from "./fixtures.js";

export type IdentityFieldKey = "name" | "dob" | "phone" | "email" | "idLast4";

export interface IdentityClaim {
  name?: string;
  dob?: string;
  phone?: string;
  email?: string;
  idLast4?: string;
}

export interface IdentityMatchResult {
  policyholder: Policyholder;
  matchedFields: IdentityFieldKey[];
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  // Treat a leading US/Canada country code as optional so a caller reciting
  // their number without "+1" still matches a fixture stored as "+1XXXXXXXXXX".
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeDob(value: string): string {
  return value.trim();
}

function normalizeIdLast4(value: string): string {
  return value.replace(/\D/g, "");
}

function matchesAny(candidate: string, values: string[]): boolean {
  return values.includes(candidate);
}

/**
 * Scores a single claimed identity against one policyholder record.
 * Matching is per-field; a name/phone/email hit against a listed alias
 * counts the same as a hit against the primary value.
 */
function scoreAgainst(claim: IdentityClaim, holder: Policyholder): IdentityFieldKey[] {
  const matched: IdentityFieldKey[] = [];

  if (claim.name) {
    const candidate = normalizeName(claim.name);
    const values = [holder.name, ...(holder.name_aliases ?? [])].map(normalizeName);
    if (matchesAny(candidate, values)) matched.push("name");
  }

  if (claim.dob) {
    if (normalizeDob(claim.dob) === normalizeDob(holder.dob)) matched.push("dob");
  }

  if (claim.phone) {
    const candidate = normalizePhone(claim.phone);
    const values = [holder.phone, ...(holder.phone_aliases ?? [])].map(normalizePhone);
    if (candidate && matchesAny(candidate, values)) matched.push("phone");
  }

  if (claim.email) {
    const candidate = normalizeEmail(claim.email);
    const values = [holder.email, ...(holder.email_aliases ?? [])].map(normalizeEmail);
    if (matchesAny(candidate, values)) matched.push("email");
  }

  if (claim.idLast4) {
    // The fixture's `id_last4` holds either an SSN-last-4 or a national-ID-last-4
    // depending on `id_type`; we match on the value the caller gives us
    // (framed to them as "last 4 of your SSN or ID"), not the type label.
    if (normalizeIdLast4(claim.idLast4) === normalizeIdLast4(holder.id_last4)) {
      matched.push("idLast4");
    }
  }

  return matched;
}

/**
 * Finds the best-matching policyholder for a partial identity claim.
 * Returns the record with the most matched fields (ties broken by fixture order).
 * Callers (the SOP's VERIFY_ID phase) decide whether the match count clears
 * the verification threshold.
 *
 * `preferredPartyId` (see DECISIONS.md #31, tightened by #36) makes this
 * **permanently sticky** to a once-established candidate for the rest of
 * the verification: as soon as a candidate has any matched field, every
 * later turn is scored against that SAME holder only, never re-picking a
 * different holder even if some other holder would score higher on the raw
 * count. This is deliberately strict, not just tie-breaking — an earlier
 * version allowed switching to a strictly-higher-scoring holder, which
 * turned out to be exploitable: a caller could accumulate matches for a
 * completely different real policyholder (e.g. correctly stating a second
 * real person's phone AND email) and get silently re-targeted onto that
 * other real identity, discarding their own already-matched field. Identity
 * verification must never re-target onto a different real person mid-call;
 * once a candidate is established, only fields checked against *that*
 * candidate count from then on. The tradeoff: if the caller's very first
 * stated field happens to coincidentally equal a completely different real
 * policyholder's data (before any of their own real fields are known), the
 * lock forms on that wrong candidate and can't self-correct — accepted as
 * a far rarer and lower-stakes failure mode than identity hijack.
 */
export function findBestIdentityMatch(claim: IdentityClaim, preferredPartyId?: string): IdentityMatchResult | undefined {
  const holders = loadPolicyholders();

  if (preferredPartyId) {
    const preferred = holders.find((h) => h.party_id === preferredPartyId);
    if (preferred) {
      const matchedFields = scoreAgainst(claim, preferred);
      if (matchedFields.length > 0) {
        return { policyholder: preferred, matchedFields };
      }
    }
  }

  let best: IdentityMatchResult | undefined;

  for (const holder of holders) {
    const matchedFields = scoreAgainst(claim, holder);
    if (matchedFields.length === 0) continue;
    if (!best || matchedFields.length > best.matchedFields.length) {
      best = { policyholder: holder, matchedFields };
    }
  }

  return best;
}

/** Looks up a policyholder by party_id — used to ground the verified caller's real name in prompts, rather than letting the model infer it from conversation history (see DECISIONS.md #33). */
export function getPolicyholderById(partyId: string): Policyholder | undefined {
  return loadPolicyholders().find((h) => h.party_id === partyId);
}
