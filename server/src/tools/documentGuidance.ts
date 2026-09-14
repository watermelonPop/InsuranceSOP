import { loadDocumentGuideline } from "./fixtures.js";

/**
 * `claims.json`'s `documents_needed` uses short names (e.g. "pathology report")
 * while this guideline file's keys use fuller names (e.g. "original pathology
 * report") — an exact match misses real claim data. Matches bidirectionally
 * by substring so either naming style finds the same guidance entry.
 */
function findGuidanceKey(lookup: Record<string, Record<string, string>>, document: string): string | undefined {
  const docLower = document.toLowerCase();
  return Object.keys(lookup).find((key) => {
    const keyLower = key.toLowerCase();
    return keyLower.includes(docLower) || docLower.includes(keyLower);
  });
}

/** Combined guidance for what to submit, given a case type and the specific documents needed. */
export function getSubmissionGuidance(caseType: string, documentsNeeded: string[]): string[] {
  const data = loadDocumentGuideline();
  const lines: string[] = [data.default_guidance.en];

  const caseGuidance = data.case_type_guidance[caseType]?.en;
  if (caseGuidance) lines.push(caseGuidance);

  for (const doc of documentsNeeded) {
    const key = findGuidanceKey(data.document_guidance, doc);
    const docGuidance = key ? data.document_guidance[key]?.en : undefined;
    if (docGuidance) lines.push(docGuidance);
  }

  return lines;
}

/** What to do if the caller can't produce a specific required document. */
export function getAlternativeGuidance(document: string): string {
  const data = loadDocumentGuideline();
  const key = findGuidanceKey(data.document_alternative_guidance, document);
  return (key ? data.document_alternative_guidance[key]?.en : undefined) ?? data.document_alternative_guidance.default.en;
}

export function getHumanReviewGuidance(): string {
  return loadDocumentGuideline().claim_followup_settings.human_review_after_document_alternatives_exhausted.en;
}

function fillTemplate(
  template: string,
  vars: { caseId: string; documents: string[] }
): string {
  const data = loadDocumentGuideline();
  return template
    .replace(/{case_id}/g, vars.caseId)
    .replace(/{documents}/g, vars.documents.join(", "))
    .replace(
      /{average_processing_time_after_submission}/g,
      data.claim_followup_settings.average_processing_time_after_submission.en
    );
}

/**
 * Finds the best-matching claim follow-up guidance for a caller's question,
 * given the intent hint the SOP/LLM has already assigned to the turn.
 * Falls back to a generic message if nothing matches.
 */
export function findFollowupGuidance(params: {
  caseId: string;
  documentsNeeded: string[];
  intentHint: string;
  utterance: string;
}): string {
  const data = loadDocumentGuideline();
  const utteranceLower = params.utterance.toLowerCase();

  const candidates = data.claim_followup_guidance.filter((g) => {
    if (!g.intent_hints.includes(params.intentHint)) return false;
    if (g.requires_documents && params.documentsNeeded.length === 0) return false;
    if (!g.match_any) return true;
    return g.match_any.some((phrase) => utteranceLower.includes(phrase));
  });

  // Prefer a keyword-specific match over a hint-only catch-all.
  const best = candidates.find((g) => g.match_any) ?? candidates[0];

  const template = best?.en ?? data.claim_followup_fallback.en;
  return fillTemplate(template, { caseId: params.caseId, documents: params.documentsNeeded });
}
