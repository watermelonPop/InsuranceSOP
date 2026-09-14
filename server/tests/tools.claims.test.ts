import { describe, expect, it } from "vitest";
import { getClaim, getClaimsForParty } from "../src/tools/claims.js";

describe("claims tools", () => {
  it("returns all claims for a party, including denied/closed/open across case types", () => {
    const claims = getClaimsForParty("P9");
    expect(claims.map((c) => c.case_id).sort()).toEqual(
      ["CL-2048", "CL-2011", "CL-1899", "CL-2102"].sort()
    );
  });

  it("returns an empty array for a party with no claims", () => {
    expect(getClaimsForParty("P-nonexistent")).toEqual([]);
  });

  it("looks up a single claim by case id with denial details intact", () => {
    const claim = getClaim("CL-2048");
    expect(claim?.status).toBe("denied");
    expect(claim?.documents_needed).toEqual(["pathology report", "office note"]);
    expect(claim?.denial_reason).toMatch(/pathology report/);
  });

  it("returns undefined for an unknown case id", () => {
    expect(getClaim("CL-does-not-exist")).toBeUndefined();
  });
});
