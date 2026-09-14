import { describe, expect, it } from "vitest";
import {
  findFollowupGuidance,
  getAlternativeGuidance,
  getHumanReviewGuidance,
  getSubmissionGuidance
} from "../src/tools/documentGuidance.js";

describe("document guidance tools", () => {
  it("combines default + case-type + per-document guidance for a healthcare claim", () => {
    const lines = getSubmissionGuidance("healthcare", ["pathology report", "office note"]);
    expect(lines.some((l) => l.includes("member portal"))).toBe(true); // default guidance
    expect(lines.some((l) => l.includes("treating provider or facility name"))).toBe(true); // case-type guidance
    expect(lines.some((l) => l.includes("pathology report should include"))).toBe(true); // document-specific
  });

  it("falls back to just default guidance for an unknown case type or document", () => {
    const lines = getSubmissionGuidance("unknown_case_type", ["some unknown document"]);
    expect(lines).toEqual([expect.stringContaining("member portal")]);
  });

  it("returns document-specific alternative guidance when available", () => {
    const guidance = getAlternativeGuidance("original pathology report");
    expect(guidance).toMatch(/hospital, lab, or treating provider/);
  });

  it("falls back to the default alternative guidance for an unlisted document", () => {
    const guidance = getAlternativeGuidance("some totally unknown document");
    expect(guidance).toMatch(/replacement copy/);
  });

  it("returns the human-review-after-alternatives-exhausted guidance", () => {
    expect(getHumanReviewGuidance()).toMatch(/human claims representative/);
  });

  describe("findFollowupGuidance", () => {
    it("matches a keyword-specific rule over the generic intent-hint catch-all", () => {
      const reply = findFollowupGuidance({
        caseId: "CL-2048",
        documentsNeeded: ["pathology report", "office note"],
        intentHint: "document_submission",
        utterance: "how do I submit the missing documents?"
      });
      expect(reply).toContain("CL-2048");
      expect(reply).toMatch(/member portal|upload link/);
    });

    it("fills in {case_id} and {documents} template placeholders", () => {
      const reply = findFollowupGuidance({
        caseId: "CL-3001",
        documentsNeeded: ["diagnosis report"],
        intentHint: "document_submission",
        utterance: "when do I need to submit this?"
      });
      expect(reply).toContain("CL-3001");
      expect(reply).toContain("diagnosis report");
      expect(reply).not.toContain("{case_id}");
      expect(reply).not.toContain("{documents}");
    });

    it("fills in the average-processing-time placeholder for processing-time questions", () => {
      const reply = findFollowupGuidance({
        caseId: "CL-2048",
        documentsNeeded: ["pathology report"],
        intentHint: "status_inquiry",
        utterance: "how long will it take after I submit?"
      });
      expect(reply).toMatch(/less than a week/);
    });

    it("falls back to the generic fallback message when nothing matches", () => {
      const reply = findFollowupGuidance({
        caseId: "CL-2048",
        documentsNeeded: [],
        intentHint: "general_claim_question",
        utterance: "completely unrelated phrasing with no keyword hits"
      });
      expect(reply).toMatch(/missing files are received/);
    });
  });
});
