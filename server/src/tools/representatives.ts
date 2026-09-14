import { loadRepresentatives, type Representative } from "./fixtures.js";

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Finds an authorized-representative record for the given (claimed
 * representative name, policyholder party id) pair. Knowing the
 * policyholder's identity fields is not sufficient on its own — the caller
 * must also be listed as an authorized representative for that specific
 * policyholder (see DECISIONS.md #23).
 */
export function findRepresentative(repName: string, buyerPartyId: string): Representative | undefined {
  const candidate = normalizeName(repName);
  return loadRepresentatives().find(
    (r) => r.buyer_party_id === buyerPartyId && normalizeName(r.rep_name) === candidate
  );
}
