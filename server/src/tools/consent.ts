import { loadConsentScenarios } from "./fixtures.js";

export interface ConsentCheckResult {
  approved: boolean;
  scenario: string;
}

const DEFAULT_SCENARIO = "default";

/**
 * Simulates checking whether the policyholder has authorized a
 * representative to access their claim. Which of `consent_scenarios.json`'s
 * named scenarios applies is selected via CONSENT_SCENARIO (defaults to
 * "default", the quick-approval path) — nothing in the fixture data ties a
 * scenario to a specific call, so this is a demo/test override rather than
 * business logic (see DECISIONS.md #23).
 *
 * Resolved instantly rather than played out turn-by-turn: a real caller
 * would never be made to wait on hold through repeated "still pending"
 * checks, so the whole status_sequence is evaluated in one step and only
 * the outcome is surfaced.
 */
export function checkConsent(scenarioNameOverride?: string): ConsentCheckResult {
  const scenarios = loadConsentScenarios();
  const scenarioName = scenarioNameOverride ?? process.env.CONSENT_SCENARIO ?? DEFAULT_SCENARIO;
  const scenario = scenarios[scenarioName] ?? scenarios[DEFAULT_SCENARIO];

  const approved = scenario.status_sequence.includes("approved");
  return { approved, scenario: scenarioName };
}
