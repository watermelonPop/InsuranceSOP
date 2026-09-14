import { describe, expect, it } from "vitest";
import { findBestIdentityMatch } from "../src/tools/identity.js";

describe("findBestIdentityMatch", () => {
  it("matches Margaret Chen on name + dob + idLast4 (3 fields)", () => {
    const match = findBestIdentityMatch({
      name: "Margaret Chen",
      dob: "1985-03-15",
      idLast4: "4472"
    });
    expect(match?.policyholder.party_id).toBe("P9");
    expect(match?.matchedFields.sort()).toEqual(["dob", "idLast4", "name"].sort());
  });

  it("matches via name/email/phone aliases (Ya Wen Li / Yaven Li)", () => {
    const match = findBestIdentityMatch({
      name: "Yaven Li",
      email: "yawen.li@example.com",
      phone: "+16505212830"
    });
    expect(match?.policyholder.party_id).toBe("P13");
    expect(match?.matchedFields.sort()).toEqual(["email", "name", "phone"].sort());
  });

  it("is case/whitespace-insensitive on name and email", () => {
    const match = findBestIdentityMatch({
      name: "  margaret CHEN  ",
      email: "MARGARET@EMAIL.COM"
    });
    expect(match?.policyholder.party_id).toBe("P9");
    expect(match?.matchedFields.sort()).toEqual(["email", "name"].sort());
  });

  it("normalizes phone number formatting before comparing", () => {
    const match = findBestIdentityMatch({ phone: "(650) 521-2836" });
    expect(match?.policyholder.party_id).toBe("P9");
    expect(match?.matchedFields).toEqual(["phone"]);
  });

  it("matches id_last4 regardless of whether the fixture's id_type is ssn or national_id (decision #7)", () => {
    // Ma Tian's fixture id_type is "national_id_last4", not "ssn_last4".
    const match = findBestIdentityMatch({ name: "Ma Tian", idLast4: "6688" });
    expect(match?.policyholder.party_id).toBe("P12");
    expect(match?.matchedFields.sort()).toEqual(["idLast4", "name"].sort());
  });

  it("returns undefined when nothing matches any record", () => {
    const match = findBestIdentityMatch({ name: "Nobody Here", dob: "2000-01-01" });
    expect(match).toBeUndefined();
  });

  it("returns undefined when given no claimed fields at all", () => {
    const match = findBestIdentityMatch({});
    expect(match).toBeUndefined();
  });

  it("picks the record with the most matched fields when multiple partially match", () => {
    // Only name matches Margaret Chen; nothing else does, so it should still surface as best (only) match.
    const match = findBestIdentityMatch({ name: "Margaret Chen" });
    expect(match?.policyholder.party_id).toBe("P9");
    expect(match?.matchedFields).toEqual(["name"]);
  });

  it("scenario 1.4: a wrong value for one field does not count as a match, even alongside a correct field", () => {
    // Right name, wrong DOB — should match on name only, not silently accept the wrong DOB.
    const match = findBestIdentityMatch({ name: "Margaret Chen", dob: "1999-01-01" });
    expect(match?.policyholder.party_id).toBe("P9");
    expect(match?.matchedFields).toEqual(["name"]);
  });

  it("scenario 1.3: exactly 2 correct fields matches only those 2, not the verification threshold", () => {
    const match = findBestIdentityMatch({ name: "Margaret Chen", dob: "1985-03-15" });
    expect(match?.matchedFields.sort()).toEqual(["dob", "name"].sort());
    expect(match?.matchedFields.length).toBe(2); // caller code must treat 2 < REQUIRED_MATCHES (3) as unverified
  });

  it("scenario 1.4 (see DECISIONS.md #31): a wrong field that coincidentally matches a DIFFERENT real policyholder does not steal the candidate away from an already-matched name", () => {
    // Ya Wen Li's real name, but a DOB that happens to be Ma Tian's (P12) real DOB.
    // Without preferredPartyId, Ma Tian ties on match-count (1) and wins on fixture
    // order (P12 comes before P13), silently discarding the correct name match.
    const withoutPreference = findBestIdentityMatch({ name: "Ya Wen Li", dob: "1964-09-10" });
    expect(withoutPreference?.policyholder.party_id).toBe("P12"); // documents the bug this fix guards against

    const withPreference = findBestIdentityMatch({ name: "Ya Wen Li", dob: "1964-09-10" }, "P13");
    expect(withPreference?.policyholder.party_id).toBe("P13");
    expect(withPreference?.matchedFields).toEqual(["name"]);
  });

  it("scenario 1.4 (see DECISIONS.md #32): never re-targets onto a different real policyholder even if they'd score higher — locking is permanent, not just tie-broken", () => {
    // The caller is genuinely P13 (matched on name). They then (deliberately
    // or not) state a phone + email that are actually Margaret Chen's (P9)
    // real data — 2 matches, strictly MORE than P13's 1. Re-targeting onto
    // P9 here would mean the system could go on to "verify" as the wrong
    // real person entirely — must never happen once a candidate is locked.
    const match = findBestIdentityMatch(
      { name: "Ya Wen Li", phone: "+16505212836", email: "margaret@email.com" },
      "P13"
    );
    expect(match?.policyholder.party_id).toBe("P13");
    expect(match?.matchedFields).toEqual(["name"]);
  });

  it("accepts the known tradeoff: a wrong initial guess that coincidentally matches a different real holder stays locked (no self-correction) as long as that holder still has any match", () => {
    // Documents the accepted residual limitation from DECISIONS.md #32: the
    // caller's very first stated field (DOB) happens to coincidentally equal
    // Ma Tian's (P12) real DOB, locking the candidate there. Even after the
    // caller then gives their own real name (which would match P13 with a
    // HIGHER score), the lock stays on P12 as long as it still has ITS one
    // match (dob) — no re-targeting, by design, even to the real holder.
    const match = findBestIdentityMatch({ dob: "1964-09-10", name: "Ya Wen Li" }, "P12");
    expect(match?.policyholder.party_id).toBe("P12");
    expect(match?.matchedFields).toEqual(["dob"]);
  });
});
