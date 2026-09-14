# Decision Log

Every design/scope decision or assumption made during this build, with the
options considered, what was decided, and why. Updated as new decision
points come up.

---

## 1. LLM provider and API auth

**Options considered (integration pattern):**
- Connector-adapter: a provider-agnostic `LLMClient` interface, with a separate adapter per provider.
- Hardcode a single model choice directly, no abstraction layer.

**Options considered (provider):**
- **Anthropic API (Claude)** — pay-as-you-go; new accounts sometimes get a small one-time credit (~$5), not guaranteed, can run out mid-testing. Not reliably free for 48 hours.
- **Google Gemini API free tier** — genuinely free (no card required), generous daily rate limits on Gemini Flash models. Quality decent but not Claude-level for nuanced empathy/SOP-following.
- **Groq API free tier** — free, very fast, hosts open models (Llama 3.x etc). Less reliable at strict instruction-following than Gemini/Claude.
- **Local model via Ollama** — completely free, zero rate limits, runs locally. Requires decent hardware; open models weaker at nuanced SOP-adherence + empathy.
- **OpenAI free trial** — small one-time credit, likely runs out before 48 hours of testing.

**Decision:** Connector-adapter pattern, with Google Gemini free tier as the initial default provider. Gemini was later replaced as the default by Groq's free tier, via the same interface (a new `GroqClient` adapter, `LLM_PROVIDER=groq`), after the originally planned default model (`gemini-2.0-flash`) was deprecated by the live API and its replacements turned out to carry a **20 requests/day** cap. Gemini is still supported (`LLM_PROVIDER=gemini`) but is no longer the default.

**Justification:** The connector-adapter pattern pays for itself the moment provider rules change, exactly as happened here — each new adapter is cheap to add once the interface exists, rather than requiring changes throughout the SOP logic. Gemini was chosen initially for its familiarity and its free tier's generous advertised allowances; once that allowance turned out not to hold in practice, Groq was the best-priced option that fit the project's budget and timeline, at the cost of somewhat less reliable strict instruction-following.

---

## 2. Retry/backoff design for LLM API errors (built for `GeminiClient`, later mirrored in `GroqClient`)

**Options considered:**
- No retry at all — fail immediately on any 429/503 and surface the error. Simplest, but turns every transient blip (a brief "high demand" 503, a per-minute quota that resets in seconds) into a hard failure the caller would see.
- Blind fixed backoff (e.g. always wait 1.5s, then retry once) regardless of error type. Better than nothing, but a fixed wait is often too short to matter for a real rate-limit error, and doesn't distinguish a quota that will clear in seconds from one that won't clear for a day.
- **Retry honoring the server's own suggested wait time, and distinguishing quota type (chosen):** short backoff on transient 503 "high demand" errors; on 429s, parse and honor the server's own suggested wait time, but only retry when the error is a **per-minute** quota — never a per-day quota — and only up to a 65s cap.

**Decision:** Retry honoring the server's suggested wait time, gated on quota type (per-minute only) and capped at 65s. The wait-time parser handles both the plain-seconds format (`"3.4725s"`) and the longer `"XmYs"` format providers use for bigger waits (e.g. daily-cap blocks), converting either to total seconds. If the parsed wait exceeds the 65s cap (`MAX_WORTHWHILE_RETRY_WAIT_SECONDS`), don't retry at all — fail immediately instead.

**Justification:** Using the server's own suggested wait time is strictly better than guessing at a fixed backoff — it waits exactly as long as needed, no more, no less. Explicitly distinguishing per-minute from per-day quota errors matters because retrying a genuinely unusable daily cap would otherwise mean silently hanging for up to a day for no benefit; failing fast on that case instead surfaces the real problem immediately, and a short capped wait couldn't have cleared a multi-minute block anyway, so retrying past the cap would only add latency before the same inevitable failure. Parsing both wait-time formats matters in practice, not just in theory: providers use the short format for quick per-minute waits and the longer format for multi-minute daily-cap waits, and a parser that only handled one would silently fall back to a useless fixed backoff on the other. The defensiveness here isn't hypothetical — a dated/pinned Gemini model name had already 404'd once this session as Google deprecated it out from under a fixed name, which is exactly the kind of provider-side surprise this retry logic is designed not to be naive about.

---

## 3. POST_PROCESS email summary — real vs. mocked

**Options considered:**
- Mocked (composed and shown/logged, not actually sent)
- Real email via SMTP/email API (requires credentials)

**Decision:** Mocked.

**Justification:** Avoids requiring SMTP/SendGrid/etc. credentials as a setup dependency for a demo whose deliverable is a test UI, not a production notification system.

---

## 4. Out-of-scope question retry threshold before offering human escalation

**Options considered:**
- 1 off-topic turn triggers an escalation offer (strictest)
- 2 consecutive off-topic turns (redirect once, then offer escalation)
- 3 consecutive off-topic turns (more lenient)

**Decision:** 2 consecutive off-topic turns: polite redirect on the 1st, explicit human-transfer offer on the 2nd in a row.

**Justification:** Balances not escalating too eagerly on a single stray question against not letting the conversation drift indefinitely off-topic.

---

## 5. Automated tests vs. manual-only testing

**Options considered:**
- Automated scenario tests (Margaret Chen happy path + bonus emotional-escalation scenario, asserting phase transitions/gate behavior)
- Manual testing via the chat UI only

**Decision:** Automated scenario tests.

**Justification:** Gives regression safety while iterating on the SOP engine and prompts.

---

## 6. Single fixed session vs. multiple concurrent sessions

**Options considered:**
- Single fixed demo session (one conversation state on the server, reset via a button/endpoint)
- Multiple concurrent sessions keyed by browser/cookie, independent state per tab

**Decision:** Single fixed demo session.

**Justification:** Matches the "simple test UI" deliverable scope; avoids building a session store for a capability the demo doesn't need.

---

## 7. Identity field: "SSN last 4" vs. fixture's mixed `id_type`

**Context:** The spec's verification fields include "SSN last 4 digits," but `policyholders.json` mixes `id_type: "ssn_last4"` and `id_type: "national_id_last4"` — not every policyholder actually has an SSN.

**Options considered:**
- Match strictly on SSN only (would make some fixture policyholders, e.g. those with `national_id_last4`, unable to verify via this field at all)
- Match on the `id_last4` value regardless of `id_type` label, and phrase the prompt generically ("last 4 digits of your SSN or ID")

**Decision:** Match on `id_last4` value regardless of type label; agent asks for "the last 4 digits of your SSN or ID."

**Justification:** Implementation-level call (not a v1-scope-altering decision), made and flagged rather than assumed silently. Matching strictly on SSN-only would make some real fixture records (e.g. Ma Tian, Ya Wen Li) practically unable to use this field for verification, which conflicts with the fixtures clearly intending it to be usable.

---

## 8. Structured per-turn extraction: reliability handling for free-tier JSON output

**Context:** Step 4 (phase state machine + memory/extraction layer) needs a structured per-turn extraction of PII/intent/case hints/emotion/in-scope-flag from each caller message, used by both the memory layer and the scope guardrail. Live testing (originally against Gemini, before the provider switch in decision #1 — the same reliability issue and fix still apply on Groq, since both are reached through the same provider-agnostic `jsonMode` flag) surfaced a real bug: on a long, PII-dense message, the model's plain-prompted JSON output was malformed (it echoed the schema back inside a string value), silently falling back to all-null/neutral/in-scope defaults and losing real signal (the "denied healthcare claim from January" hint).

**Options considered:**
- Keep prompt-only JSON instructions and just retry blindly on any failure
- Use the provider's structured-output mode (`jsonMode` — Gemini's `responseMimeType: "application/json"`, Groq's `response_format: { type: "json_object" }`) plus a single retry on parse failure, falling back to permissive defaults only if both attempts fail

**Decision:** Use the provider's JSON response mode for the extraction call, wrap the call in try/catch so both a returned unparseable result *and* the call itself throwing are treated as the same retryable failure (Groq's own JSON-mode validator can fail server-side and throw mid-conversation as context grows, not just return malformed text), add one retry before falling back, and fail open (default to `inScope: true`, neutral emotion, no hints) if both attempts fail, rather than fail closed. The extraction call's `maxOutputTokens` is set to 900 (not a tighter budget) to reduce how often that server-side validator failure happens in the first place.

**Justification:** JSON mode alone reduced but did not eliminate malformed/truncated output on the free tier; a cheap retry cleared the remaining transient cases in testing. Catching thrown errors alongside returned-but-unparseable ones matters because both are the same underlying failure mode from the caller's perspective — treating only one of them as retryable would leave the turn crashing outright whenever the provider happened to fail the other way. Failing open on total failure was chosen deliberately — a mis-parsed extraction should never itself block or misdirect the caller (e.g. wrongly declare something out-of-scope); the cost of an occasional missed memory hint is much lower than the cost of an incorrectly blocked or escalated caller.

---

## 9. Engine was clobbering remembered intent/case hints on off-topic turns

**Context:** Independent of decision #8's extraction-reliability bug (this one happens downstream, on an already-successfully-parsed extraction result) — the engine was unconditionally overwriting `memory.intentHint`/`caseTypeHint` on every turn, including off-topic ones. An off-topic aside ("how do airplanes fly?") clobbered a genuine intent hint captured earlier in the call.

**Options considered:**
- Merge `intentHint`/`caseTypeHint` only on turns the extractor marked in-scope, skipping the merge entirely otherwise
- Merge unconditionally but only when the new value is non-null and the *existing* stored value is empty (i.e. first-write-wins, never overwrite once set)
- Keep separate `lastRawHint` (every turn) and `lastReliableHint` (in-scope turns only) fields, and have phase handlers read only the reliable one

**Decision:** Only merge `intentHint`/`caseTypeHint` into conversation memory on turns the extractor marked in-scope; PII fields are still merged unconditionally since identity data is orthogonal to topical scope.

**Justification:** An off-topic remark's "intent" is noise, not a genuine case hint, and should never overwrite a real one captured earlier in the call. First-write-wins was rejected because a caller should be able to correct/refine their stated intent on a later in-scope turn (e.g. narrowing "my claim" to "my auto claim from February"); gating on in-scope preserves that while still blocking noise. The dual-field option was rejected as unneeded complexity — no phase handler needs the unreliable raw value, so there's nothing to justify carrying it.

---

## 10. Document-name lookups used exact string matching against mismatched fixture data

**Context:** Found while writing mocked test coverage for `tools/documentGuidance.ts`. `claims.json`'s `documents_needed` uses short names (e.g. `"pathology report"`, `"office note"`) while `required_document_guideline.json`'s guidance keys use fuller names (e.g. `"original pathology report"`, `"treating provider office note"`) — an exact-match lookup in `getSubmissionGuidance`/`getAlternativeGuidance` silently found nothing for real claim data, meaning PROCESS_CASE (step 6, not yet built) would have quietly lost document-specific guidance the moment it started using these tools.

**Options considered:** exact match only (status quo, rejected — it's the bug, confirmed by a failing test); bidirectional substring matching between the claim's document name and the guidance key (chosen); a hardcoded alias map between the two naming conventions (rejected — brittle, requires manual upkeep as fixtures change, unnecessary given substring matching already resolves every case in the current data).

**Decision:** Bidirectional substring matching between the claim's document name and the guidance key.

**Justification:** Every mismatch in the current fixtures is a strict substring relationship in one direction (the short name is contained in the fuller key), so bidirectional substring matching resolves all of them without hardcoding fixture-specific knowledge. Caught only because a test was written that used real fixture values instead of made-up document names.

---

## 11. Automated test strategy: mocked LLM vs. live API

**Context:** Decision #7 already settled on writing automated scenario tests, but not how those tests should get their LLM responses — hitting the real provider on every run is slow, consumes quota, and is non-deterministic; a pure mock never catches real prompt/model regressions.

**Options considered:**
- Mock the `LLMClient` entirely — fast, free, deterministic, but blind to prompt-wording or real-model regressions
- Hit the real Groq API on every test run — realistic, but slow, consumes quota every run, and can flake on rate limits/model variance
- Both: a fast mocked suite as the default safety net, plus a separate live-API suite run on demand

**Decision:** Both, as separate test files: `tests/*.test.ts` (mocked, run by `npm test`) and `tests/*.live.test.ts` (real Groq API, run only via `npm run test:live`). Both use the same `runScenario()` helper driving the real SOP engine — only the underlying `LLMClient` differs (a scripted `FakeLLMClient` vs. the real provider client), via a test-only `setLLMClientOverride()` hook added to `llm/index.ts`. Live tests assert looser invariants (verification threshold met, phase correctness, no claim-detail leakage) since exact wording varies by model; live tests auto-skip if no API key is present rather than failing.

**Justification:** Needed a way to develop against fast/free mocks and periodically re-validate against the real API, without maintaining two separate test suites. Sharing the scenario runner and only swapping the `LLMClient` achieves that with no duplicated test logic — confirmed working: 8/8 mocked tests and 2/2 live tests pass as of this writing.

---

## 12. Never say "let me check" or stall when the facts are already available — applied to PROCESS_CASE, then VERIFY_ID

**Context:** Found during step 6 live testing. Asked "why was it denied?", the model replied "let me pull that up... I'll let you know shortly" even though the denial reason was already in its system prompt — a pure prompt-following lapse (open-weight model risk, per decision #1), not a data/logic bug. The same anti-pattern later turned up in `VERIFY_ID` too (scenario 1.4, Ya Wen Li): after the caller's third message, the model replied "I have everything I need to complete the verification, so please hold just a moment... I'll be right back with you" — a stalling non-answer that claimed sufficiency it didn't have and never actually asked for the still-missing field. Since nothing in this system proactively continues a conversation, a stalling reply is a dead end either way: the caller has to guess what to say next.

**Decision:** Added an explicit instruction to `PROCESS_CASE`'s `BASE_RULES` that all facts are already looked up and the model must answer immediately, never say it needs to check or get back to the caller. Added the matching hard rule to `VERIFY_ID`'s `buildSystemPrompt` too: never say "please hold" / "give me a moment" / "I'll be right back" / "I have everything I need" unless verification is actually confirmed true, and directly ask for the specific still-needed field(s) in the same reply.

**Justification:** The facts genuinely are already in the prompt (or, in VERIFY_ID's case, the caller genuinely hasn't finished providing what's needed) — there's nothing to "go check," so the fix is to make that explicit rather than let the model default to a plausible-sounding customer-service filler phrase that happens to be false here. `VERIFY_ID` should never have been missing this rule once it was already proven out in `PROCESS_CASE` — not treated as a security issue in either phase, since the deterministic state (`matchedFields`/`verified`) was never at risk; the LLM only controls phrasing, never the underlying computation. This is purely a UX dead-end being fixed at the prompt level, which is enough here since VERIFY_ID's open-ended clarification-asking (unlike POST_PROCESS's fixed-shape recap) doesn't lend itself to a simple template-based fallback.

**Verified:** 121 mocked tests passing (1 new, confirming the new rule text is present in VERIFY_ID's prompt whenever the caller isn't yet verified). Live-verified VERIFY_ID's fix against the exact reported 3-turn transcript — the final reply now directly asks for the still-missing field (SSN or phone) instead of stalling.

---

## 13. Phone number matching was too strict

**Context:** Found while writing mocked test coverage for `tools/identity.ts`. `normalizePhone` only stripped non-digit characters, so a caller reciting their number without a "+1" country code (e.g. "(650) 521-2836") would never match a fixture stored as `"+16505212836"` — an 11-digit vs. 10-digit exact-match mismatch.

**Options considered:** require exact match only (status quo, rejected — it's the bug); strip a leading US/Canada country-code digit when present (chosen); do a fuzzy last-10-digits comparison regardless of length (rejected — overly permissive, could match unrelated shorter inputs).

**Decision:** Strip a leading "1" when the digit string is 11 digits long, so "+1"-prefixed and bare 10-digit forms are treated as equivalent.

**Justification:** All fixture phone numbers are `+1`-prefixed US numbers; callers reciting a phone number aloud very rarely include the country code, so treating the two forms as equivalent reflects realistic caller behavior without introducing false positives for actually-different numbers.

---

## 14. PROCESS_CASE fabricated contact details

**Context:** Found during step 6 live testing. Asked how to submit missing documents, one run's reply invented a specific email address, an 800-number, and a mailing address — none of which exist anywhere in the fixture data or grounded-facts prompt. This is the most severe possible grounding failure (fabricated a functioning-looking way to contact the company). A second run on the same question, unmodified, did not reproduce it — confirming this is model-level non-determinism/hallucination risk rather than a deterministic code bug.

**Decision:** Hardened the system prompt with an explicit, high-emphasis instruction never to invent email/fax/phone/mailing-address/URL details and to offer human/portal referral instead; added a live-test regex guard (checks every reply in the full-journey scenario for email/phone/street-address patterns) as an ongoing regression tripwire.

**Justification:** This failure mode is exactly the kind that could pass a review by coincidence (as the non-reproducing second run demonstrated) and reappear later — the regex guard exists specifically so a recurrence gets caught automatically rather than relying on noticing it again by chance.

---

## 15. No terminal state on escalation acceptance

**Context:** Verifying step 7 (out-of-scope classifier + escalation counter) was actually complete before moving to POST_PROCESS. The guardrail/counter itself was already built and tested in step 4, but review surfaced a real gap: nothing gave the escalation flow an actual terminal state once a caller accepted a transfer offer.

**Options considered:**
- Add a terminal `ESCALATED` phase: detect an affirmative reply to a just-made transfer offer, end the SOP loop with one fixed handoff message, and stay there for any further input.
- Leave it purely conversational — the LLM keeps saying "connecting you now" in character with no state change, accepting the risk of it looping or repeating.

**Decision:** Added a terminal `ESCALATED` phase. Implementation: a new `state.humanTransferOffered` flag is set whenever either the scope guardrail's off-topic escalation or VERIFY_ID's no-progress persuasion cutoff makes an offer; the *next* turn is checked deterministically (regex, no LLM call — `guardrails/escalation.ts`) for an affirmative response before running the normal pipeline. On acceptance, `state.phase = "ESCALATED"` and every subsequent turn short-circuits to a fixed handoff message without further LLM calls or SOP logic.

**Justification:** A real demo of the bonus "know when to stop persuading and escalate" behavior needs an actual, visible, predictable end state — not just the LLM improvising "connecting you" indefinitely, which could repeat, contradict itself, or never actually stop. Checking acceptance deterministically (not via another LLM call) keeps this gate as reliable as the identity-verification gate itself, consistent with the project's overall "SOP controls phase order, LLM handles phrasing" design.

**Verified live end-to-end:** the full refusal → persuasion-cutoff → transfer-offer → "yes, transfer me" → terminal handoff flow now works exactly as intended, including the model proactively offering transfer slightly earlier than the deterministic cutoff on its own initiative (harmless — the deterministic gate only *requires* the offer by a certain point, it doesn't forbid the LLM from being extra proactive). Test suite grew to 66 mocked + 3 live (one live test's timeout raised from 30s to 60s after a legitimate Groq rate-limit backoff pushed a 4-turn scenario over the old limit).

---

## 16. POST_PROCESS: terminal state after the email-consent decision, and implementation notes

**Context:** The instructions don't specify what happens after the caller decides on the email summary (accept or skip).

**Options considered:**
- End in a terminal `DONE` state (chosen) — consistent with the `ESCALATED` pattern from decision #15; any further input gets a fixed "this call has ended" reply, no further LLM calls.
- Stay open for further questions, routing back into PROCESS_CASE/RESOLVE_INTENT as needed.

**Decision:** Terminal `DONE` state, mirroring `ESCALATED`'s architecture (same short-circuit-at-top-of-engine pattern, same "dead code but type-total" handler). The yes/skip consent decision itself reuses the same deterministic `isAffirmativeResponse` check from decision #15 rather than a second LLM classification call, and an accepted email is mocked via `console.log` (decision #3) rather than an actual SMTP/API call.

**Justification:** Matches POST_PROCESS's role as the last of the 4 defined workflow phases; consistent with the precedent set in decision #15 rather than introducing a second, different pattern for "conversation might continue after this." Reusing the same deterministic yes/no check as every other consent-style gate in this system (rather than a bespoke classifier for this one) keeps it exactly as reliable as the identity and transfer-acceptance gates.

**Verified:** Live end-to-end: the full verify → resolve → process → wrap-up → mock-email → DONE journey passes, including the wrap-up summary correctly containing the real, grounded denial reason.

---

## 17. POST_PROCESS wrap-up trigger design

**Context:** The instructions don't specify what triggers leaving PROCESS_CASE for the POST_PROCESS wrap-up. Pure closing-phrase detection alone risks never reaching POST_PROCESS if the caller never says a closing phrase — but a hard turn-count cutoff (force wrap-up after N turns, no matter what) has the opposite problem: it unconditionally truncates a caller who legitimately has more than a few questions, conflating "never get stuck forever" with "never cut off an engaged caller" into one mechanism that only achieves the first at the expense of the second.

**Options considered:**
- Detect explicit closing phrases only (risk: never reached if the caller doesn't say one)
- A hard turn-count cutoff, forcing wrap-up after N turns regardless of what the caller says (risk: truncates a caller who legitimately has more questions)
- **Closing-phrase detection plus a soft check-in (chosen):** `guardrails/closing.ts` (deterministic, no LLM call) handles the natural/fast path; separately, after a set number of PROCESS_CASE turns, the agent answers the caller's current question as normal and then asks "Would you like me to wrap up this call with a summary now, or do you have more questions?" — a real transition to POST_PROCESS only happens if the caller affirms. Declining resets the turn counter and the check-in can recur later if the caller keeps going that long.

**Decision:** Closing-phrase detection + soft check-in.

**Justification:** The check-in question is itself the deterministic progress guarantee — asked on a fixed schedule regardless of caller behavior, so the conversation can never silently loop forever without ever addressing wrap-up — while never overriding a caller who explicitly wants to keep going, unlike a hard cutoff would. Verified live both ways: declining the check-in, asking another grounded question, and getting a correct answer while staying in PROCESS_CASE; and accepting the check-in, correctly producing the grounded summary and transitioning to POST_PROCESS.

---

## 18. A real follow-up question got swallowed by a phase-transition turn

**Context:** Running the exact Margaret Chen scenario by hand (post-delivery) surfaced a real bug: turn 1 (the combined identity+intent message) correctly verified and moved to `RESOLVE_INTENT`. Turn 2 — "Why was the claim denied?" — is itself a real, answerable question, but got RESOLVE_INTENT's generic "I found your claim, I'll look into it" confirmation instead of an actual answer, because RESOLVE_INTENT's design (from step 6) deliberately takes its own turn to confirm the resolved claim before PROCESS_CASE gets a turn to answer anything. That confirmation reply also implied the agent would proactively follow up ("I'll let you know as soon as I have that information"), which it wouldn't — the caller would have had to ask a third time.

**Options considered:**
- Chain RESOLVE_INTENT → PROCESS_CASE within the same turn whenever resolution succeeds, so a real question in that turn's message gets answered immediately instead of deferred (chosen) — narrow, only affects this one transition.
- Generic same-turn chaining through all phase transitions (e.g. VERIFY_ID → RESOLVE_INTENT → PROCESS_CASE all in one hop when the data supports it) — fixes this and any similar case elsewhere, but changes conversational pacing everywhere (e.g. a single message with identity + a direct question could skip straight to a full grounded answer without ever separately confirming verification), reversing an earlier deliberate pacing choice.
- Reword RESOLVE_INTENT's confirmation to stop implying a proactive follow-up — cheaper, but doesn't fix the actual wasted turn; the caller would still have to repeat their question.

**Decision:** Chain RESOLVE_INTENT → PROCESS_CASE specifically. On resolving the claim, `resolveIntent.ts` now calls `handleProcessCase` directly with the same `userMessage` instead of generating its own confirmation reply, so a real question is answered in the very turn the claim is resolved. VERIFY_ID's existing pacing (confirm verification first, defer specifics) is untouched.

**Justification:** The targeted fix directly addresses the reported bug with minimal blast radius, and preserves the already-tested VERIFY_ID confirmation behavior rather than risking new pacing surprises elsewhere. Chaining is architecturally safe here (PROCESS_CASE only ever speaks from freshly-fetched grounded facts, so there's no risk of it disclosing ungrounded data) even though it's now reached via delegation rather than a fresh top-level dispatch. Verified live: the exact reported transcript now gets a correct, grounded denial-reason answer on turn 2 instead of the stalling confirmation. Full test suite re-run clean: 76 mocked + 4 live.

---

## 19. A failed phase-handler LLM call had no fallback and crashed the whole request as a raw 500

**Context:** A raw 500 error occurred ("Internal error handling message," shown directly in the chat UI with no in-character framing) when a caller asked to be transferred to a human. Root cause traced via the running Docker container's logs to a newly-discovered Groq constraint: a tokens-per-day (TPD) cap of 200,000/day, separate from the per-minute limits already known (decisions #2, #14) — cumulative testing had driven usage to 199,865/200,000, so nearly every request was failing. Not a code defect in the transfer-handling logic itself (which worked correctly once it could run) — but it exposed a real robustness gap: nothing caught a thrown LLM-call error and degraded gracefully.

**Options considered (for the fallback placement):** handle the fallback in the Express route (`api/server.ts`) vs. in `sop/engine.ts`.

**Decision:** Added graceful degradation in `sop/engine.ts`: if a phase handler's conversational LLM call throws (provider outage, exhausted quota, anything), the engine now catches it and returns an in-character fallback reply ("having trouble connecting... would you like to be transferred to a human representative?") instead of propagating a raw error — and sets `humanTransferOffered = true` so the caller can actually get to a human immediately, via the existing deterministic (no-LLM-required) transfer-acceptance check. This means transfer-acceptance keeps working even while the LLM itself is completely unavailable, since that check runs before any LLM call. Chose the engine over the route so the fallback reply still flows through the normal history-push and state handling — keeping `historyForLLM` consistent with what's shown in the chat UI, and going through one code path rather than duplicating logic between the route and the engine.

**Justification:** A straightforward reliability fix — never let an LLM outage produce a broken, unrecoverable chat turn. Verified against the actual exhausted key: a request that previously 500'd now returns the graceful fallback and correctly offers (and completes) a human transfer with zero working LLM calls available.

---

## 20. Emotion-awareness was VERIFY_ID-only

**Context:** Found while backfilling test coverage for the scenarios in `TEST_SCENARIOS.md`. Reviewing coverage surfaced that the bonus spec describes empathetic handling as a general support-agent quality, not one confined to identity verification, but only VERIFY_ID had the acknowledgment pattern.

**Options considered:** extend the same lightweight emotion-acknowledgment pattern to RESOLVE_INTENT and PROCESS_CASE; or leave it scoped to VERIFY_ID only, since the instructions' worked bonus example is specifically about identity verification.

**Decision:** Extended it to both other freeform phases via a small shared helper (`sop/phases/emotionPrompt.ts`) that adds a brief "acknowledge before answering" instruction whenever `analysis.emotion` isn't neutral.

**Justification:** A caller can just as easily be frustrated while asking about their claim specifics as during identity verification. Verified live: a frustrated "why on earth was my claim denied?" mid-PROCESS_CASE now gets acknowledged before the grounded denial reason is given, in one natural reply.

---

## 21. A real sidebar bug found immediately by writing new frontend tests

**Context:** While writing new `App.test.tsx` coverage for the chat UI's phase-conditional debug sidebar, found that the "Off-topic streak" row's visibility condition excluded `phase === "DONE"` but not `phase === "ESCALATED"`, inconsistent with the "Last emotion" row (which correctly excluded both) and with the intended design ("ESCALATED shows nothing but the phase badge," per the design table agreed on before implementing the phase-conditional sidebar). A caller who escalated after racking up an off-topic streak would have seen a stray "Conversation signals" section in a phase meant to show nothing else.

**Fix:** Refactored the three duplicated inline conditions into two shared `showEmotion`/`showOffTopicStreak` booleans plus an `isConversationOver` flag, so this class of "forgot to exclude one terminal state" bug can't reoccur by construction — the phase-exclusion logic now lives in exactly one place instead of three.

**Justification:** This is a case where a handful of tests caught a real, shipped bug that pure code review across this entire session had missed (it required rendering the actual conditional JSX and observing what shows up in a specific phase, which is exactly the class of bug component tests catch and prose review doesn't). Test suite: web now 9 tests (new), server unaffected at 101.

---

## 22. Implemented claim-switching (scenario 4.8)

**Context:** Claim-switching mid-conversation had initially been left unimplemented as an unspecified, out-of-scope feature (there's no code path for a caller pivoting to a different one of their claims mid-`PROCESS_CASE` — the resolved claim never gets revisited once set). On revisiting priorities, it was implemented after all.

**Design:** Extracted the claim-scoring/ambiguity-resolution logic that previously lived only in `resolveIntent.ts` into a new shared module, `sop/phases/claimResolution.ts` (`scoreClaimForHint`, `pickBestClaim`, `askWhichClaim`), so `RESOLVE_INTENT`'s initial resolution and `PROCESS_CASE`'s new switch-detection use identical logic rather than duplicating it (and avoids a circular import between the two phase files). `resolveIntent.ts` is now a thin caller of the shared module.

`processCase.ts` now checks, at the top of every turn, whether `state.memory.caseTypeHint` (already updated by the engine's `mergeMemory` before the phase handler runs) points to a *different* case type than the currently resolved claim:
- **Exactly one claim of the new type** → switch to it immediately (same turn, same pattern as the RESOLVE_INTENT→PROCESS_CASE chaining from decision #18 — answer the caller's real question against the newly-switched claim's grounded facts, no separate "switching now" announcement needed) and reset `processCaseTurnCount` (a fresh conversation about a different claim shouldn't immediately trigger the wrap-up check-in).
- **Multiple claims of the new type** (ambiguous even after narrowing by type) → don't guess; transition to `RESOLVE_INTENT` and ask a grounded clarifying question via `askWhichClaim`, identical to the initial-resolution ambiguous path.
- **No claims of the new type** (caller doesn't actually have one) → proceed unchanged; a caseTypeHint alone doesn't prove a real claim exists to switch to.

**Justification for this design vs. alternatives:** Reused `RESOLVE_INTENT`'s existing scoring/ambiguity machinery rather than inventing new logic, since the underlying question ("which claim does the caller mean, given hints") is identical whether it's the first resolution or a mid-conversation switch — this also means the switch-detection inherits the same "never guess when ambiguous" safety property rather than needing it reimplemented and re-verified separately. Resetting the turn counter on switch (rather than leaving it running) avoids an already-in-progress check-in countdown from a *different* claim's conversation prematurely truncating a fresh one.

**Verified:** 105 mocked tests passing (4 new: unambiguous switch, ambiguous-switch clarification, no-op when the hint matches the current claim, no-op when the caller has no claim of the hinted type). Not yet verified live — Groq quota was exhausted when this was implemented; a spot-check once quota allows would be worthwhile before considering this fully done, since claim-switching depends on the real extraction correctly producing a case-type hint mid-conversation, which is exactly the kind of thing scenario 10.3's live test is designed to probe.

---

## 23. Implemented the combined representative + consent-authorization feature

**Context:** `representatives.json`/`consent_scenarios.json` had initially been left out of v1 scope as two independently-weak, disconnected ideas — the spec never mentions a non-policyholder calling on someone's behalf or any consent step. Re-reading `consent_scenarios.json`'s values (`"pending"` → `"approved"`, or stuck pending for `"timeout"`) against `claims.json`'s actual statuses (`denied`/`closed`/`open` — never `"pending"`/`"approved"`) showed the original "claim-status simulation" reading didn't fit the data at all. The better fit: `consent_scenarios.json` is a consent/authorization-request state machine for the `representatives.json` scenario — when a non-policyholder calls about someone else's claim, the system checks whether the policyholder has authorized them, and the two named scenarios (`default`: approved, `timeout`: stuck pending) simulate the two outcomes. The combined feature was implemented on the strength of this reading.

**Design:** A representative call requires the caller to supply the **policyholder's** identity fields (same 3-of-5 check, just about the account they're calling on behalf of) — `representatives.json` has no PII for the representative themselves, so this is forced by the data shape, not a real choice. Once identity clears, the system separately checks `representatives.json` for a record matching that policyholder + the caller's own stated name, and `tools/consent.ts`'s `checkConsent()` for an approved outcome (resolved instantly — no real caller should wait through repeated "still pending" round-trips) — only on both does verification complete. Denial at either step reuses the existing `humanTransferOffered` escalation mechanism rather than inventing new plumbing. `CONSENT_SCENARIO` (env var, defaults to `"default"`) picks which fixture scenario applies, mirroring how `GEMINI_MODEL`/`GROQ_MODEL` overrides already work. The per-turn extraction schema gained `callerRole`/`representativeName` fields; `RESOLVE_INTENT`/`PROCESS_CASE`/`POST_PROCESS` needed zero changes since they already operate purely on `state.identity.partyId`, which is always the policyholder's ID regardless of which path verified the call.

**Justification:** Reusing the existing 3-of-5 matching, extraction schema, and escalation mechanism (rather than building parallel machinery) keeps this within the system's established patterns and cost budget — a denied representative reaches a human exactly the same way a frustrated policyholder can.

**Verified:** 111 mocked tests passing (needs-rep-name, approved, denied-not-authorized, denied-consent-timeout, and a regression check that ordinary policyholder calls never engage this gate). Not yet verified live at the time — depends on the real LLM correctly extracting `callerRole`/`representativeName` from natural phrasing like "I'm calling on behalf of my mother," which mocks can't confirm.

---

## 24. No confirmation of which claim was found before diving into details (scenario 3.3)

**Context:** Verifying Ma Tian (single claim, no stated reason for calling) and then saying "I need help with a claim" jumped straight into his denied claim's details without ever confirming which claim was found — a jarring skip for a vague opener, unlike a message that already asks a specific question (where decision #18's chaining is exactly the right call). Root cause: `RESOLVE_INTENT`'s chain into `PROCESS_CASE` (decision #18) and `PROCESS_CASE`'s own claim-switch chaining (decision #22) always skip the "found it" confirmation, regardless of whether the caller's message was a real question or just a generic request.

**Fix:** Added a one-turn `state.claimJustResolved` flag, set whenever a claim is newly resolved (`resolveIntent.ts`) or switched (`processCase.ts`'s switch-detection), consumed on the very next `PROCESS_CASE` answer to add an instruction confirming which claim was found (case type + status) in one clause before answering — then cleared, so it never repeats on later turns for the same claim.

**Justification:** Chose a one-turn flag over always confirming (which would repeat needlessly on every subsequent question) or never confirming (the reported bug) — the flag exists for exactly the turns where the caller hasn't yet been told which claim is being discussed.

**Verified:** 113 mocked tests passing (1 new: `resolveIntent.test.ts` scenario 3.3).

---

## 25. POST_PROCESS wrap-up silently skipped the summary and email question

**Context:** Found via manual testing (scenario 4.8 test, but not specific to that feature — general POST_PROCESS reliability). Live transcript: caller said "okay bye" after a long conversation; `isClosingSignal` correctly matched and `generateWrapUp` was correctly called, but the model's reply was a bare "It was a pleasure helping you today... have a wonderful day!" — no claim summary, no email question — despite the system prompt explicitly instructing both. A real prompt-adherence lapse by the model, not a code defect; confirmed by tracing the exact code path (the observed reply text doesn't match the graceful-degradation fallback wording from decision #19, so the LLM call itself succeeded and simply didn't follow instructions).

**Fix:** Since the spec explicitly requires the caller be able to choose send-or-skip for the email summary, this can't be left to model reliability alone. `generateWrapUp` now deterministically checks whether its own output mentions "email" at all, and appends a fixed follow-up question ("Would you like me to email you a summary of this call, or would you rather skip that?") if it doesn't — guaranteeing the requirement is met regardless of what the model actually said, while still using the model's own summary content when it behaves correctly.

**Justification for the append-rather-than-retry approach:** A retry (as used elsewhere for JSON-mode parsing, decision #8) would cost another full LLM call and still isn't guaranteed to succeed a second time. Deterministically appending a fixed sentence guarantees compliance with a hard spec requirement at zero additional cost or latency, and is not user-visible as awkward since it reads as a natural continuation of whatever the model did say.

**Verified:** 113 mocked tests passing (1 new: `postProcess.test.ts` email-guarantee test using the fake client's default reply, which never mentions "email," to simulate the exact observed failure). Not yet re-verified live.

---

## 26. UI could silently show a misleading "fresh" state after a page refresh

**Context:** Manual testing surfaced what looked like a severe bug (Ma Tian's verification producing a clarifying question listing *Margaret Chen's* claim types) but turned out to be a genuine UX gap, not a data-isolation bug: the browser page had been refreshed (rather than clicking "Reset conversation") between tests. A page refresh only resets `App.tsx`'s React state (`messages`, `phase`, `debug` all start over via `useState` defaults) — it does nothing to the actual server-side conversation, which lives in the single fixed session (decision #6) and only resets via `/reset`. So the UI showed an empty `VERIFY_ID` chat while the server was still mid-conversation as Margaret Chen, and the next message got processed against her leftover state.

**Decision:** Added `GET /state`, returning the real current phase, full message history (reconstructed from `state.historyForLLM`), and debug info — the same shape `/message` already returns, factored into a shared `buildDebugPayload()` helper to avoid duplicating it. `App.tsx` now calls this on mount (before rendering any assumed-fresh empty state) and syncs to whatever the server actually reports, showing a brief "Loading conversation…" state while it does.

**Justification:** This wasn't a hypothetical — it produced a genuinely confusing, wrong-looking result during real testing (mixed policyholder data) even though the underlying identity-matching and session logic were both working exactly as designed. A test UI that can silently lie about what phase the conversation is actually in undermines the whole point of having a debug sidebar. No design alternatives really apply here — this is a straightforward correctness gap (missing state sync) rather than a judgment call.

**Verified:** 113 server tests unaffected; 11 web tests passing (2 new, covering both the restore-from-server-state case and the genuinely-empty-session case). Live-checked directly against `GET /state` (on a separate port from the running Docker container, to avoid disturbing the in-progress manual testing session) — confirms it accurately returns phase, full message history, and debug info matching the real server-side conversation.

---

## 27. POST_PROCESS wrap-up recap: deterministic facts as a guaranteed floor, with validated LLM enrichment for conversation-specific detail

**Context:** The wrap-up summary needed to cover every claim discussed in a call ("what was discussed, the claim status/outcome, and the major follow-up items," per spec), not just whichever claim was active at hang-up. Trusting the LLM to generate this directly failed repeatedly in live testing: it dropped the email question on one call (decision #25), dropped the substantive recap entirely on another, and — even after being given every discussed claim's facts — still missed real conversation-specific content (e.g. a caller's actual question about submitting documents physically instead of online). This was the third distinct instruction-following failure on this exact structured task, past the point where another round of prompt tuning was worth trying — but a fully static template has the opposite problem: it can never reflect what a caller actually asked about, no matter how many individual facts get hardcoded into it.

**Decision:** `generateWrapUp` uses a generate-then-validate-then-fallback pattern (the same shape as `analyzeTurn`'s retry/fallback handling, decision #8):
1. Compute a deterministic recap line for every claim discussed that call (tracked via `state.discussedCaseIds`, recorded once per turn regardless of which resolution/switch path led there) — status-appropriate facts (denial reason + documents + appeal deadline + both online/member-portal and physical/fax-mail submission options for denied claims; net payment for closed; expected reimbursement for open). This is the guaranteed-correct floor.
2. Ask the LLM to weave those exact facts into one natural recap, explicitly allowed to also reference specific things discussed in the conversation, but forbidden from inventing anything beyond what it was given.
3. Validate: the enriched reply must actually contain every discussed claim's case ID. If it does, use it (plus the always-appended, never-LLM-dependent email question). If it doesn't — or the call fails outright — fall back to the plain deterministic recap.

The resulting text is generated once and stored verbatim in `state.postProcess.summaryText`, then reused as-is for the mock email body — so the "email" a caller receives always matches what was actually said in the call, rather than risking drift from a second, independently-generated version.

**Justification:** This is the same validate-and-fall-back-to-safe-default shape already used for structured extraction (`analyzeTurn`, decision #8) — after multiple consecutive live failures trusting the model with the full task, the fix needed to stop depending on it for the part that must be correct, without permanently forfeiting the thing it's actually good at (natural, conversation-aware phrasing). The deterministic facts guarantee nothing required is ever missing; the enrichment step recovers real conversational nuance whenever the model behaves, and costs nothing when it doesn't since the fallback is always the safe deterministic version, never a further LLM attempt. The submission-method guidance is included unconditionally in the deterministic floor (not just when asked about) because it's a standing, always-true fact for any denied claim with outstanding documents — hardcoding it doesn't lose anything a caller-specific tracking system would have caught.

**Verified:** 116 mocked tests passing (covering: `discussedCaseIds` accumulates every claim discussed across a multi-claim conversation; the deterministic floor always contains every discussed claim's facts, including both submission options for denied claims; the enrichment step falls back correctly when its reply is missing a required case ID; and uses the enriched reply verbatim — including conversation-specific detail the deterministic template alone couldn't know — when it correctly includes every required fact). Not yet re-verified live at this point — this is the point to specifically re-test the physical-submission scenario, since that's exactly the kind of conversation-specific content this change is meant to recover.

---

## 28. Model fabricated an entire fake "add a representative" workflow — blocked deterministically before generation

**Context:** Manual testing of the representative feature (decision #23) tried the natural next step: Margaret (verified policyholder) asking to *authorize* a new representative herself, e.g. "Give access to John Smith, my son, to all my claims." This capability doesn't exist anywhere in the system — `representatives.json` is a static, read-only list checked only when a rep calls in; there's no enrollment/write path at all. Instead of saying so, the model invented an entire fake multi-step process: asking for John's DOB, asking for John's SSN last 4, and claiming it would "grant access" once provided — fabricating both a nonexistent feature and a reason to collect a third party's sensitive PII.

**Why this is more serious than the earlier wrap-up failures:** Those were the model failing to include real, already-given facts. This is the model inventing a plausible-sounding process wholesale, with no grounding to correct it against — `PROCESS_CASE`'s "if the caller asks something these facts don't cover, say you're not sure" instruction was already in the system prompt and was simply ignored. There's no fact-grounding fix available here (unlike decision #14's fabricated-contact-info fix, which worked because real facts existed to ground against) — the entire capability is imaginary, so the only real fix is stopping the request before it reaches the model at all.

**Options considered:**
- Strengthen the "say you're not sure" instruction further, or add an explicit "you cannot add representatives" rule to `PROCESS_CASE`'s system prompt — rejected: this is the fourth documented case this session of the model ignoring an explicit instruction on a request that falls outside its tightly-grounded paths (decisions #14 the first time, #24, #27, and now this); no reason to expect a prompt change fixes a demonstrated pattern.
- Deterministic pre-generation guardrail (chosen) — same category as the existing off-topic and closing-signal guardrails: detect the request pattern and short-circuit with a fixed, honest response before any LLM call happens.

**Decision:** Added `guardrails/unsupportedCapabilities.ts` — `isRepresentativeEnrollmentRequest()`, a keyword/phrase-pattern check (explicit relationship nouns near "add"/"authorize", plus "give access", "grant ... access", "consent to ... representative", "call in ... on my behalf" — deliberately excludes generic pronouns like "him"/"her" to avoid false-matching unrelated sentences). Wired into `sop/engine.ts` as an early gate, before `analyzeTurn` even runs, alongside the existing terminal-state and human-transfer-acceptance checks — so this costs zero LLM calls and can't be reached by any phase handler. Returns a fixed, honest message explaining the limitation and offers a human transfer, reusing the same `humanTransferOffered`/deterministic-acceptance mechanism as every other escalation path in this system.

**Justification:** This is the same shape of fix as the off-topic scope guardrail and the closing-signal detector — a known category of request that needs a hard, predictable answer rather than a judgment call handed to the model. Given the demonstrated pattern of this model ignoring "don't guess" instructions specifically when a request falls outside its grounded paths, and given the severity here (soliciting a third party's SSN for a fabricated purpose), this isn't a case where "flag and monitor" is an acceptable risk posture — it needed a hard block.

**Verified:** 120 mocked tests passing (6 new: pattern-matching tests for realistic phrasings including the exact two reported messages, a check that the real representative-calling-in flow and other real messages don't false-positive, an engine-level test confirming zero LLM calls happen, and a human-transfer-acceptance follow-through test). Live-verified against both exact reported messages — both now correctly blocked with the fixed message instead of fabricating the fake workflow.

---

## 29. VERIFY_ID never explained why a rejected value didn't count

**Context:** In a live transcript (real fixture identity: Ya Wen Li), the caller gave a wrong DOB, then a wrong SSN, then a correct email, then a wrong phone. Only `name` + `email` ever matched (2 of the required 3) — the deterministic matching was correct throughout, but the model was never told *which* field the caller just gave was wrong: `buildSystemPrompt` only ever received the aggregate matched/missing field lists, not what was rejected this specific turn. So every reply asked for another field as if nothing had been given at all, instead of saying "that DOB doesn't match what we have on file."

**Decision:** Compute which field(s) the caller stated *this specific turn* that didn't end up matched (`rejectedFieldLabels`), and pass them into the prompt with an explicit instruction to name them plainly before asking for something else.

**Justification:** A straightforward information gap — same category as decision #24's "tell the model more of what it needs to know" fix.

**Verified:** 124 mocked tests passing (1 new: rejected-field callout present when a value was just rejected, absent when nothing new was stated). Live-verified against the exact real fixture identity (Ya Wen Li) with a wrong DOB, wrong SSN, and wrong phone in sequence — each turn now correctly names the just-rejected field ("That date of birth doesn't match what we have on file...", "That email doesn't match...", "That phone number doesn't match...") instead of asking for "one more piece" as if nothing had been given.

---

## 30. VERIFY_ID could hallucinate verification success (or a later phase) while deterministically still unverified

**Context:** In a reported transcript (same one as decision #29), the model twice claimed "I'll go ahead and complete the verification" and then answered a claim question in a pulled-up-details style ("let me pull up the details... could you share the claim number or the date of service") — despite `state.identity.verified` deterministically staying `false` the entire time (phase never left `VERIFY_ID`). The very next turn then reverted to asking for name + DOB again "to verify your identity" — the conversation was never actually in a later phase; the model was just improvising a false narrative on top of a state that hadn't changed, in both directions. This directly violates the existing hard rule "Never claim the caller is verified unless told below that they are" — not a new category of failure, but the most severe instance of it since it fabricates a false *success* state rather than just a stalling non-answer (decision #12) or a nonexistent capability (decision #28).

**Options considered:**
- Strengthen the existing "never claim verified" instruction further — rejected: this is not the first time in this session a prompt-only instruction has been demonstrably ignored by this model on exactly this kind of judgment call (decisions #25, #27, #28, #29); no reason to expect a stronger wording fixes a demonstrated pattern.
- Deterministic post-generation validation (chosen) — same generate-then-validate-then-fallback shape already used in `analyzeTurn` (decision #8) and `generateWrapUp` (decision #27): let the model generate normally, then check its output against the one thing that's cheap and certain to check (`state.identity.verified` is deterministically `false`), and override with a safe, correct, template-based re-prompt if the model's reply falsely implies otherwise.

**Decision:**
- Added `FALSE_VERIFICATION_CLAIM_PATTERN`, checked against the model's reply whenever `state.identity.verified` is still `false`; on a match, discard the reply and substitute a deterministic, always-correct `buildFallbackReprompt` (names the rejected field if any, otherwise lists what's still missing). The regex is deliberately narrow — matching only phrases that can *only* ever appear as an outright claim of success (`verification is (now )?complete`, `i'll go ahead and complete (the|your) verification` — requiring the specific "I'll go ahead and..." lead-in from the originally observed bug, "you're verified," and the specific stalling/claim-number phrasing already seen), never phrases that could also appear in ordinary explanatory language. An earlier, broader version of this regex (matching any mention of "complete... verification") caused its own bug: it fired on completely correct, on-topic answers like "we ask for this to complete the verification process" (a legitimate reply to "why do you need my SSN?"), silently discarding a good answer and replacing it with the generic fallback — arguably worse than the bug it guards against, since it actively throws away a correct reply rather than just producing a wrong one. The narrow version closes that gap while still catching the original failure.
- Applied the same "never imply re-verification is needed / never ask for a claim number" hard rule to `PROCESS_CASE`'s `BASE_RULES` and to `askWhichClaim`'s system prompt, in case the false narrative is instead picked up *after* a real transition (both are the other two LLM-driven surfaces reachable once verified).

**Justification:** Unlike decision #12's stalling bug (a wording-only dead end with no security exposure, since the deterministic state was never at risk), this bug's *symptom* was the model narrating a false verified state — even though the underlying gate never actually opened (no claim data was ever disclosed in the reported transcript), a model that will confidently claim "verified" when it isn't is exactly the failure mode a strict identity gate cannot tolerate as a matter of wording alone. Given four prior documented cases this session of prompt-only instructions being ignored on judgment calls, deterministic validation was the right tool rather than another prompt tweak. The safety net's own job is narrow and specific (catching only claims of success), which is exactly why it needed tightening once it was shown to also catch normal conversation about the verification *process* in general — consistent with the project's overall principle that phase transitions and gate status are never LLM-decided, only LLM-phrased; this fix makes sure a false LLM *claim* about phase/verification status can't reach the caller and contradict what the deterministic layer actually decided, even if the LLM says otherwise.

**Verified:** 137 mocked tests passing (covering: the false-verification-claim override triggers and replaces the reply; doesn't fire on an ordinary correct reply that happens to mention "complete the verification" in passing; and the original regression — the exact literal phrase "I'll go ahead and complete the verification on my end now" — still correctly triggers the override). This identity has no claims on file in the fixtures, so this fix's exact PROCESS_CASE path couldn't be replayed live against this specific transcript; it's a direct extension of the same validated pattern (decision #27) and covered by mocked tests, but is flagged here as not yet independently live-verified against a real multi-claim account — worth a follow-up spot check if this failure mode recurs.

---

## 31. Real bug: a coincidentally-matching field from a DIFFERENT real policyholder could silently steal the identity-matching candidate mid-verification

**Context:** A follow-up test on the same 1.4 scenario (Ya Wen Li) used "wrong" values that happened to be *other real policyholders'* actual data — `1964-09-10` is Ma Tian's real DOB, `+16503882920` is Ava Lopez's real phone, `4472` is Margaret Chen's real SSN last-4 (all visible in `policyholders.json`). Reported symptom: the "that doesn't match what we have on file" explanation (decision #29's fix) never appeared until the very last wrong value — every prior turn just repeated a generic "share one more of" fallback with no reference to the field just given, and it also **dropped the already-confirmed name match**, listing "full name" as still missing again after it had already been acknowledged.

**Root cause:** `tools/identity.ts`'s `findBestIdentityMatch` re-picks the single best-scoring policyholder **from scratch every turn**, with ties broken purely by fixture array order. On turn 2, Ya Wen Li (P13, matches on `name`) and Ma Tian (P12, matches on `dob` — the coincidental real value) both scored 1 match; Ma Tian is earlier in the fixture array, so `>` (strictly-greater-only) never replaced it as `best`, silently making Ma Tian the "current candidate" instead of Ya Wen Li. Every prompt/label computed downstream (`matchedFieldLabels`, `missingFieldLabels`, `rejectedFieldLabels`) was then built against the *wrong* candidate's match set, which is why the real name match vanished and the rejected-field explanation (which reads off `rejectedFieldLabels`, itself derived from the same recomputed `matchedFields`) silently broke too — decision #29's fix was correct, it was just being fed already-corrupted input.

**Options considered:**
- Break ties by something other than fixture order (e.g. most-recently-active candidate) — same shape as the chosen fix, just less explicit about *why*.
- Keep a running/sticky matched-fields set per turn instead of recomputing from scratch — rejected: this would let a field that was *once* stated (even if the caller has since moved on or corrected it) count forever even after being overwritten by a different value, which conflicts with the existing "always match on the latest stated value" design (state.identity.claimed already only holds one current value per field).
- **Sticky candidate keyed on `state.identity.partyId`, tie-break only (chosen):** `findBestIdentityMatch` now accepts an optional `preferredPartyId`; when computing the best match, a holder that's strictly better than the preferred one still wins outright (so a caller who mistypes their very first field can still self-correct onto the real holder later), but on an exact tie the preferred holder wins instead of falling back to fixture order.

**Justification:** This preserves both correctness properties that matter: (1) a coincidental single-field match against an unrelated real person can never outrank or tie-break away an already-established real candidate just because of array position — the actual account holder isn't "punished" for someone else's data existing in the fixtures — while (2) a genuinely wrong first guess doesn't permanently trap the caller, since the preferred candidate only wins ties, never outright victories by a stronger-scoring holder. This is a correctness fix to the identity tool itself, not a prompt change — the deterministic matching was the thing actually wrong here, unlike decisions #12/#29 which were LLM-phrasing/reliability issues sitting on top of correct deterministic state.

**Verified:** 126 mocked tests passing (2 new in `tools.identity.test.ts`: one documents the bug reproduced without the fix — `findBestIdentityMatch` without `preferredPartyId` still returns P12 for this exact input, proving the test isn't vacuous — then confirms passing `preferredPartyId: "P13"` fixes it; a second confirms self-correction still works when the preferred candidate is later out-scored by the real holder). Live-verified against the exact reported sequence (wrong DOB → wrong phone → wrong SSN → wrong email → correct name+DOB → correct SSN): `matchedFields` now correctly stays locked at `["name"]` throughout every coincidental wrong value, each rejection is explained by field, and verification completes cleanly once the real values are given.

---

## 32. Security bug: decision #31's "self-correction" leniency allowed identity-hijack onto a different real policyholder

**Context:** A follow-up test on the same scenario: after locking onto the real candidate (Ya Wen Li, matched on `name`), they then stated a DOB, SSN, and phone that were each individually a different real policyholder's real data (correctly rejected each time, per decisions #29/#31) — but then added Margaret Chen's real *email* on top of her already-stated real *phone*. Margaret Chen (P9) then scored 2 matched fields (phone + email), strictly more than the locked candidate's 1 (name) — and decision #31's rule explicitly let a strictly-higher-scoring holder override the lock "so a caller who mistyped their very first field isn't permanently locked out of correcting it." The system silently re-targeted verification onto Margaret Chen, discarding the caller's own real name match.

**Why this is more severe than a UX bug:** This is an actual identity-hijack path, not just a confusing message. If the caller had gone on to give one more of Margaret Chen's real fields, the system would have completed verification **as Margaret Chen** — a real policyholder who never called — rather than as themselves. Decision #31 fixed the wrong-message symptom but the "self-correction" mechanism it introduced was itself a new, more serious defect: it let matches accumulate for a *different* identity by raw count, with no requirement that those matches be internally consistent with a single real caller.

**Options considered:**
- Keep tie/strict-win self-correction but require the new candidate to also carry forward the previously-matched field(s) (e.g. only switch if the new candidate matches on `name` too) — rejected: fragile, and "field consistency" doesn't generalize (a caller could still assemble a qualifying combination for someone else that happens to include a shared field by coincidence).
- Require a minimum score gap (e.g. new candidate must beat the old by 2+) before switching — rejected: arbitrary threshold, doesn't eliminate the exploit, just raises the bar for it.
- **Permanent lock, no self-correction at all (chosen):** once a candidate has any matched field under the current claim, every subsequent turn scores only against that same candidate. A different holder is never substituted in, regardless of relative score. Falls back to a fresh best-holder search only if the preferred candidate's match count actually drops to zero (which in practice only happens if the caller's identifying field is later overwritten with yet another different value that also fails to match).
- **Accepted tradeoff:** if the caller's very first stated field happens to coincidentally equal a *different* real policyholder's real data before any of their own real fields are known, the lock forms on that wrong holder and cannot self-correct afterward, even once their own correct name is given. This scenario requires the caller's very first message to consist of a field that isn't their own and is, coincidentally, some other real customer's actual data — reflagged as far rarer and lower-stakes than the demonstrated hijack path, and no code change can fully eliminate it while still keeping the primary hijack fixed. If this needs full self-correction later, the actual answer is uniquely establishing identity on `name` first before scoring other fields (name is a much stronger, harder-to-coincidentally-collide signal than a 4-digit ID or a DOB) rather than the current "any field can be candidate #1" scoring — noted as a possible future refinement, not built here since the current fixture set's realistic worst case is already covered by this fix.

**Justification:** Identity verification must never be able to re-target onto a different real, named policyholder mid-call — that's a correctness property with actual security weight, not a preference. Decision #31's leniency was added specifically to avoid a caller-experience inconvenience (a bad first guess locking them out); this decision judges that tradeoff to have been wrong once it's clear the leniency is directly exploitable, and reverses it in favor of the strict, safe behavior — consistent with the project's overall stance that gates like this are handled deterministically and conservatively, never optimized for convenience over correctness.

**Verified:** 127 mocked tests passing (updated the #31 self-correction test into two: one confirming the hijack path is now blocked — Margaret Chen's real phone+email no longer displaces the locked real candidate — and one documenting the accepted residual tradeoff, that a coincidental wrong first guess still can't self-correct). Live-verified against the exact reported sequence: `matchedFields` now correctly stays locked on `["name"]` through every one of Ma Tian's/Ava Lopez's/Margaret Chen's coincidentally-matching real fields, and correctly proceeds to `["name", "dob"]` once the caller's own real DOB is given.

---

## 33. Bug found via re-test of #32's fix: the model addressed the verified caller by the WRONG real person's name

**Context:** Re-testing the exact #32 hijack scenario (Ya Wen Li's real identity, with Ma Tian's/Ava Lopez's/Margaret Chen's real fields tried and rejected along the way) to confirm the fix. The deterministic layer worked perfectly — `matchedFields`/`partyId` stayed correctly locked to Ya Wen Li throughout, and verification correctly completed on her own real `name`+`dob`+`idLast4` (confirmed via `/state` debug output). But the model's final reply said "Great news, **Margaret**—I've successfully verified your identity..." — the caller's real name is Ya Wen Li; "Margaret" only ever appeared in the conversation as a *rejected* email domain (`margaret@email.com`) several turns earlier. This is not a repeat of #32's hijack (no state/security issue — the account being verified was correct throughout) — it's the model picking up a stray, previously-rejected name-like token from conversation history instead of grounding on the actual verified identity.

**Root cause:** `buildSystemPrompt` never told the model whose name to actually use. It relies on the model to infer "the caller's name" from the conversation transcript, which is exactly the kind of thing this session has repeatedly found this model unreliable at once a transcript contains multiple candidate names/values (decisions #30, #32's underlying symptom was similar: the model latching onto stray context instead of authoritative state).

**Decision:** Added `getPolicyholderById()` to `tools/identity.ts` (looks up a policyholder record by `party_id`) and a new `verifiedHolderName` prompt field: whenever a candidate is locked (`state.identity.partyId` is set), the prompt now includes an explicit hard rule — "if you address the caller by name, use ONLY '<real on-file name>' ... NEVER use a different name, even if a different name appears elsewhere in the conversation." This grounds the one fact that matters (who is actually being verified) directly from state, rather than leaving it to inference from a transcript that may contain other people's incidentally-mentioned data.

**Justification:** Same category of fix as decision #29's rejected-field grounding and the `PROCESS_CASE`/`askWhichClaim` "already verified" hard rules — when the model has repeatedly shown it will pick up the wrong detail from an ambient transcript instead of the one piece of ground truth that actually matters, the fix is to state that ground truth explicitly and forbid deviation, not to hope better wording alone resolves it eventually. Scoped narrowly (only added once a candidate exists) so it doesn't add noise to the very first turn(s) before any name is known.

**Verified:** 129 mocked tests passing (2 new: the instruction is present and correctly names the matched candidate once one exists; absent before any candidate is matched). Live-verified against the exact reported sequence — the final reply now correctly says "Great news, Ya Wen Li—you're now verified" instead of "Margaret."

---

## 34. Closing-signal ("bye ends the call") handling, extended to every phase that lacked it

**Context:** An infinite loop was reported: a verified caller with genuinely zero claims on file (Ya Wen Li, P13 — confirmed against `claims.json`, not a bug in claim lookup) asked for help, said "Okay bye" twice, and got the exact same message repeated verbatim both times, never reaching `DONE`. Root cause: `resolveIntent.ts`'s zero-claims branch was a dead end by construction — unlike every other path that can end a call (`PROCESS_CASE`'s `isClosingSignal` check, the off-topic escalation offer, the representative-not-authorized paths), it never checked for a closing signal or wired up `state.humanTransferOffered`. Fixing that surfaced the same gap in two more places: mid-`VERIFY_ID` (before verification completes) and `RESOLVE_INTENT`'s ambiguous/no-claim-resolved branch both treated "Okay bye" as ordinary pushback instead of ending the call.

**Options considered:**
- Honor a closing signal only once verified/resolved (leave the three gaps as-is) — rejected: a real caller can hang up at any point in a real phone call, verified or not; there's no reason the SOP should trap them in a phase.
- Honor it everywhere, routing through `POST_PROCESS`'s email-summary flow regardless of what's been discussed — rejected: `POST_PROCESS`'s entire purpose (decision #16) is wrapping up *case-specific* handling, and none of these three exit points have a specific claim to summarize; emailing "a summary of this call" to someone not yet verified is also a small security smell in its own right.
- Honor it everywhere, ending straight at `DONE` with a plain farewell (chosen).

**Decision:** Added `isClosingSignal` + a live `humanTransferOffered` wire-up to `resolveIntent.ts`'s zero-claims branch, an `isClosingSignal` check to the top of `handleVerifyId` (only when not yet verified), and moved `resolveIntent.ts`'s closing-signal check to the top of the handler so it covers both the zero-claims and ambiguous paths uniformly — same phase-exit shape everywhere (deterministic check, no LLM call, transition straight to `DONE`). The resulting rule, applied uniformly: `POST_PROCESS`'s email-summary flow is reserved for calls that actually reached `PROCESS_CASE` and discussed a real claim; every earlier exit point ends with a plain farewell straight to `DONE`.

**Justification:** The same class of gap as decision #23 (and the earlier claim-switching deferral) — an unspecified fixture edge case that the original build never gave a real exit path, only discovered because the fixtures happen to include one. Extending the fix to VERIFY_ID/RESOLVE_INTENT once discovered isn't a new design direction, just the same already-established pattern applied everywhere it was missing — these two design questions were settled explicitly before building, not assumed, specifically because the second one touches `POST_PROCESS`'s scope (a previously-settled decision, #16) rather than being purely additive.

**Verified:** 136 mocked tests passing (covering: zero-claims + closing signal → `DONE`; zero-claims sets `humanTransferOffered`; VERIFY_ID closing signal → `DONE` with zero LLM calls; a control test confirming normal verification is unaffected; RESOLVE_INTENT's ambiguous branch closing signal → `DONE` with zero LLM calls). Live-verified against the exact reported transcript and both extended paths: mid-VERIFY_ID and mid-RESOLVE_INTENT "Okay bye" both now end cleanly at `DONE` instead of looping or being treated as pushback.

---

## 35. Fixing #34 surfaced a second, independent bug: "okay, bye" could be misread as accepting a human transfer

**Context:** Once #34's fix made the zero-claims branch's transfer offer genuinely live, a second, independent, pre-existing bug surfaced: `guardrails/escalation.ts`'s `isAffirmativeResponse` matches the bare word "okay" via `\b(yes|yeah|...|okay|ok|...)\b`, which also matches inside "okay, bye." The engine's transfer-acceptance gate (`sop/engine.ts`, checked before the phase handler ever runs) misread "Okay, bye" as *accepting* the transfer, landing in `ESCALATED` instead of the caller's actual intent — ending the call normally.

**Decision:** Fixed the engine's transfer-acceptance gate to check `isClosingSignal` **before** `isAffirmativeResponse`: a message that's a closing signal is never treated as accepting a transfer, regardless of what else it loosely matches. This is a general fix (not scoped to the zero-claims path) since the same ambiguity could occur anywhere a transfer offer happens to be live when the caller says goodbye.

**Justification:** A natural consequence of a generic, deliberately-simple word-list regex (`isAffirmativeResponse`'s own docstring says "deliberately simple... not interpretive") being asked to disambiguate "okay" (agreement) from "okay" (a filler word preceding an unrelated closing signal) — rather than trying to make the regex itself context-aware, checking the more specific signal (closing) first and short-circuiting is the same "most specific guardrail wins" pattern already used elsewhere (e.g. the representative-enrollment guardrail runs before the general scope guardrail).

**Verified:** 133 mocked tests passing (2 new: the engine gate test proving "okay, bye" no longer escalates, and a control test proving a genuine "yes" still does).

---

## 36. VERIFY_ID's just-verified confirmation falsely implied proactive follow-up when no intent hint exists

**Context:** In scenario 2.3 (partial/vague intent hint), after verifying with no stated reason for calling, the confirmation message ("...I'll go ahead and look into it for you") sounded like the agent was about to proactively investigate something — misleading, since nothing happens until the caller actually says what they need. This is the same anti-pattern already fixed once in a different spot: decision #18 found RESOLVE_INTENT's confirmation reply had the identical issue ("I'll let you know as soon as I have that information") and was fixed there — but the equivalent instruction was never added to `VERIFY_ID`'s own "just verified" and representative-"approved" prompt branches, which had no rule against implying proactive action at all.

**Decision:** Split the "just verified" and rep-gate-"approved" prompt branches on whether an `intentHint` actually exists:
- **No hint:** explicit instruction to end the reply with an open question inviting the caller to say what they need help with, and an explicit ban on phrases like "I'll go ahead and look into it" / "let me pull that up" — the agent genuinely doesn't know what claim is meant yet, so nothing can happen until the caller says.
- **Hint exists:** kept the existing "acknowledge you remember it" framing, but added an explicit ban on claiming the lookup is happening *this reply* — the actual resolution only happens once the caller's next message chains through `RESOLVE_INTENT`/`PROCESS_CASE` (decision #18's existing chaining behavior), so even the hint case shouldn't claim present-tense action.

**Justification:** Consistent with the standing principle (already applied once for RESOLVE_INTENT in decision #18, and for PROCESS_CASE/`BASE_RULES` re: "let me pull that up") that the agent should never claim to be doing something it isn't actually doing yet — this was simply the one remaining prompt in the system with no such rule. Splitting behavior on hint-presence matches the expected behavior exactly: reference the real hint when one exists, otherwise ask directly rather than imply foreknowledge.

**Verified:** 139 mocked tests passing (2 new: no-hint case gets the open-question/no-implied-action instruction; hint-present case still gets the hint acknowledgment but also the new "not this reply" ban). Live-verified against the exact reported scenario (no hint) — now ends with a plain "How can I assist you today?" instead of implying proactive lookup.

**Separate issue found while live-verifying, flagged rather than silently patched here:** a distinct bug in `memory/extract.ts`'s `intentHint` extraction, unrelated to this decision's prompt changes — see decision #37.

---

## 37. Fixed the flagged extraction bug: bogus "intentHint" describing identity/verification itself

**Context:** Decision #36 flagged but deliberately didn't fix a separate issue found while live-verifying: `analyzeTurn` sometimes extracts an `intentHint` like "providing ID last 4 digits for verification" from a message that was purely an identity field (e.g. just "4472"), with no actual reason for calling stated. Rebuilding and retesting confirmed this was still happening, with the sidebar showing "Remembered intent: providing ID last 4 digits for verification" — a nonsensical, non-topical hint that then fed into #36's hint-acknowledgment branch ("I'll look into that next") with nothing real to look into.

**Options considered:**
- Prompt-only fix (add an explicit rule to `EXTRACTION_SYSTEM_PROMPT`: never describe providing identity/verification info as an `intentHint`) — added, but given this session's repeated pattern of prompt-only instructions being unreliable on exactly this kind of judgment call (decisions #30, #32, #33, #36), not trusted alone.
- Deterministic post-processing filter (chosen, in addition to the prompt fix): after parsing the extraction response, run the resulting `intentHint` through a pattern check for verification-noise phrasing (`providing/confirming/sharing/stating` + `SSN/ID/DOB/phone/email/last four`, or any mention of "verify"/"verification") and null it out if it matches, before it's ever merged into `state.memory.intentHint` or fed to any prompt.

**Justification:** Same "generate-then-validate" pattern used throughout this session (decisions #8, #27, #29) — let the model attempt the extraction normally, but never trust a value that reads as an obvious category error into stored memory or a downstream prompt without a cheap, deterministic sanity check first. A real topical intentHint (e.g. "denied healthcare claim from January") never matches this pattern, so no legitimate hint is at risk of being discarded.

**Verified:** 141 mocked tests passing (2 new in `memory.extract.test.ts`: the exact reported bogus hint is discarded; a real hint stated alongside identity fields in the same message survives untouched). Live-verified against the exact reported transcript: `memory.intentHint` is now correctly empty after providing only identity fields, and the verified-confirmation reply is a clean open question with no nonsensical "intent" reference.

---

## 38. The literal spec demo scenario could fail resolution on the follow-up turn

**Context:** A final live re-run of the exact spec demo scenario, before considering the project complete, found a real regression: turn 1 (identity + intent) verified and remembered the hint correctly, but turn 2 ("Why was it denied?") failed to resolve to `CL-2048` and instead asked for a claim number. Root cause: `scoreClaimForHint` matched the "denied" status keyword via an exact substring check. The per-turn extractor re-derives `intentHint`'s wording every turn, and on turn 2 it paraphrased the hint as "explain **denial**" instead of "denied" — which doesn't contain "denied" as a substring, so the keyword check silently failed, `CL-2048` (denied) and `CL-2011` (same case type, closed) tied, and `pickBestClaim` correctly refused to guess between a tie that was itself an artifact of the check being too narrow. This also surfaced a secondary slip: `askWhichClaim`'s fallback asked for a claim number instead of clarifying by case type/status, since nothing in its prompt forbade asking for identifiers the model was never given.

This exact instability had been observed and accepted as a risk once before (step 6 live testing: a resolution taking 3 turns instead of 1 due to extraction wording variance) — logged then as an inherent risk of using a smaller open-weight model for structured extraction, not worth fixing. This is that risk materializing against the literal spec scenario, with the mechanism now understood.

**Decision:**
- Broadened `scoreClaimForHint`'s keyword matching from exact substrings to word-variant regexes covering the extractor's realistic paraphrases (`deni(ed|al)`/`declin(ed|e)` for denied; `clos(ed|e)` for closed; `open(ed|ing)?` for open).
- Banned `askWhichClaim` from asking for a claim number, case ID, or date of service — clarify using ONLY case type/status, the only things actually in the grounded list it's given.

**Justification:** The same category of fix as decision #22's underlying design (case-type/status keyword scoring) meeting the same reality already learned the hard way in decisions #30/#36: this system's per-turn extraction output varies in wording turn to turn, so anything matching against extracted text needs to tolerate realistic paraphrasing, not just the one exact phrase seen in the spec sample. Given this broke the literal, most-important scenario in the entire spec, it was treated as a priority fix rather than a minor edge case.

**Verified:** 144 mocked tests passing (1 new: resolves correctly even when the hint says "denial" instead of "denied"). Live re-verified the full spec demo scenario end-to-end (correct resolution to `CL-2048`, no re-asking) and the bonus emotional-support example (acknowledges frustration, never discloses or skips the verification gate).
