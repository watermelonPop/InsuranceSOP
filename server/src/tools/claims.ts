import { loadClaims, type Claim } from "./fixtures.js";

export function getClaimsForParty(partyId: string): Claim[] {
  return loadClaims().filter((c) => c.party_id === partyId);
}

export function getClaim(caseId: string): Claim | undefined {
  return loadClaims().find((c) => c.case_id === caseId);
}
