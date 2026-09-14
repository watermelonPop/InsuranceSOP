import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dev: server/src/tools -> ../../../fixtures = insurance_claims/fixtures.
// In Docker, FIXTURES_DIR is set explicitly (see Dockerfile) since the
// compiled dist/ layout sits at a different depth from fixtures/.
const FIXTURES_DIR = process.env.FIXTURES_DIR ?? path.resolve(__dirname, "../../../fixtures");

function loadJson<T>(filename: string): T {
  const filePath = path.join(FIXTURES_DIR, filename);
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

export interface Policyholder {
  party_id: string;
  name: string;
  name_aliases?: string[];
  policy_number: string;
  dob: string;
  id_type: string;
  id_last4: string;
  phone: string;
  phone_aliases?: string[];
  email: string;
  email_aliases?: string[];
}

export interface Claim {
  case_id: string;
  party_id: string;
  case_type: string;
  created_at: string;
  status: string;
  summary: string;
  denial_reason?: string;
  documents_needed?: string[];
  appeal_deadline?: string;
  expected_reimbursement_amount: string;
  allowed_max_amount: string;
  net_pay: string;
  net_fee: string;
}

export interface Representative {
  rep_name: string;
  relationship: string;
  buyer_name: string;
  buyer_party_id: string;
}

export interface ConsentScenario {
  status_sequence: string[];
}

export type ConsentScenarios = Record<string, ConsentScenario>;

export interface DocumentGuidelineData {
  default_guidance: Record<string, string>;
  case_type_guidance: Record<string, Record<string, string>>;
  document_guidance: Record<string, Record<string, string>>;
  document_alternative_guidance: Record<string, Record<string, string>>;
  claim_followup_settings: Record<string, Record<string, string>>;
  claim_followup_guidance: Array<{
    topic: string;
    intent_hints: string[];
    requires_documents: boolean;
    match_any?: string[];
    en: string;
  }>;
  claim_followup_fallback: Record<string, string>;
}

let policyholdersCache: Policyholder[] | undefined;
let claimsCache: Claim[] | undefined;
let documentGuidelineCache: DocumentGuidelineData | undefined;
let representativesCache: Representative[] | undefined;
let consentScenariosCache: ConsentScenarios | undefined;

export function loadPolicyholders(): Policyholder[] {
  if (!policyholdersCache) {
    policyholdersCache = loadJson<Policyholder[]>("policyholders.json");
  }
  return policyholdersCache;
}

export function loadClaims(): Claim[] {
  if (!claimsCache) {
    claimsCache = loadJson<Claim[]>("claims.json");
  }
  return claimsCache;
}

export function loadDocumentGuideline(): DocumentGuidelineData {
  if (!documentGuidelineCache) {
    documentGuidelineCache = loadJson<DocumentGuidelineData>("required_document_guideline.json");
  }
  return documentGuidelineCache;
}

export function loadRepresentatives(): Representative[] {
  if (!representativesCache) {
    representativesCache = loadJson<Representative[]>("representatives.json");
  }
  return representativesCache;
}

export function loadConsentScenarios(): ConsentScenarios {
  if (!consentScenariosCache) {
    consentScenariosCache = loadJson<ConsentScenarios>("consent_scenarios.json");
  }
  return consentScenariosCache;
}
