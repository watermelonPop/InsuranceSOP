# Test Scenarios

A checklist spanning every behavior called for in the project instructions,
using the real fixture data so messages are copy-paste-able. Organized by
spec section. **Mocked** = covered by the automated mocked-LLM suite
(`npm test`). **Live** = covered by the automated live-LLM suite
(`npm run test:live` / `sopEngine.live.test.ts`). **Manual** = exercised
through a real conversation by hand (UI or curl) against the real LLM.

For the full story behind any bug found while testing a scenario — options
considered, decision, justification — see `DECISIONS.md`.

Reference data (from `fixtures/`):
- **Margaret Chen** (P9): POL-9921, DOB 1985-03-15, SSN last4 4472, phone +16505212836, email margaret@email.com — 4 claims: `CL-2048` (healthcare, **denied** — missing pathology report + office note, appeal deadline 2026-03-18), `CL-2011` (healthcare, closed), `CL-1899` (dental, closed), `CL-2102` (auto, open)
- **Ma Tian** (P12): POL-8836, DOB 1964-09-10, national ID last4 6688, phone +16502088799 — 1 claim: `CL-3001` (healthcare, denied — missing diagnosis report, appeal deadline 2026-04-15)
- **Ya Wen Li** (P13): POL-7742, DOB 1989-12-03, national ID last4 5317, aliases: name "Yaven Li", email yawen.li@example.com, phone +16505212830 — no claims in fixture data
- **David Chen**: Margaret Chen's (P9) only authorized representative in `fixtures/representatives.json`. `CONSENT_SCENARIO` env var controls the authorization outcome (`default` = approved, `timeout` = denied).

Always start each scenario with **Reset conversation** unless the scenario says otherwise.

| ID | Test | Description | Mocked | Live | Manual |
| --- | --- | --- | :---: | :---: | :---: |
| 1.1 | Full info at once | Spec sample: all identity fields plus intent hint in one message | ✅ | ✅ | ✅ |
| 1.2 | Partial info across turns | Identity fields given one at a time across 3 turns | ✅ | ⬜ | ✅ |
| 1.3 | Exactly 2 fields, stop | Exactly 2 matched fields stays unverified | ✅ | ⬜ | ⬜ |
| 1.4 | Wrong value | Right name, wrong DOB/SSN/phone — mismatch is named, not silently ignored | ✅ | ⬜ | ✅ |
| 1.5 | Alias identity | Verify as Ya Wen Li using her alias name/email/phone | ✅ | ⬜ | ✅ |
| 1.6 | National ID vs SSN wording | Verify as Ma Tian using "last four of my ID" instead of "SSN" | ✅ | ⬜ | ✅ |
| 1.7 | Claim info requested before verification | Ask for claim details as the very first message, zero identity given | ⬜ | ✅ | ⬜ |
| 1.8 | Clarification mid-verification | "Why do you need my SSN?" — fields must survive the aside | ✅ | ⬜ | ✅ |
| 1.9 | Extra irrelevant info volunteered | Spec sample includes an unused policy number | ⬜ | ⬜ | ✅ |
| 1.10 | Closing signal mid-verification | "Okay, bye" before identity is confirmed | ⬜ | ⬜ | ✅ |
| 2.1 | Intent hint remembered from VERIFY_ID | Hint given during VERIFY_ID carries into RESOLVE_INTENT | ⬜ | ⬜ | ✅ |
| 2.2 | Off-topic remark doesn't corrupt a hint | An off-topic aside shouldn't overwrite a real intent hint | ⬜ | ⬜ | ✅ |
| 2.3 | Partial/vague hint | "It's about my auto claim" (no "denied") resolves to `CL-2102` | ✅ | ⬜ | ✅ |
| 3.1 | No hint at all | Verify Margaret, never say why she's calling | ⬜ | ✅ | ⬜ |
| 3.2 | Ambiguous hint | "My healthcare claim" matches 2 claims — should ask, not guess | ✅ | ⬜ | ✅ |
| 3.3 | Single-claim caller, no hint | Ma Tian → resolves to his only claim, `CL-3001` | ⬜ | ⬜ | ✅ |
| 3.4 | Real question as the resolving message | A direct question itself resolves intent | ⬜ | ⬜ | ✅ |
| 3.5 | Verified policyholder with zero claims on file | Ava Lopez / Ya Wen Li — no claims exist | ✅ | ⬜ | ✅ |
| 3.6 | Closing signal in ambiguous branch | "Bye" before picking which claim | ⬜ | ⬜ | ✅ |
| 4.1 | Denial reason | Why was the claim denied | ⬜ | ⬜ | ✅ |
| 4.2 | Documents needed | Asked as its own distinct question | ✅ | ⬜ | ⬜ |
| 4.3 | Submission method / no fabricated contact info | How to submit documents — no invented emails/fax/addresses | ⬜ | ✅ | ✅ |
| 4.4 | Alternatives | "I can't get the pathology report" | ✅ | ⬜ | ⬜ |
| 4.5 | Appeal deadline | Asked explicitly | ⬜ | ⬜ | ✅ |
| 4.6 | Amounts | Asked explicitly — confirms `$0.00` for the denied claim | ⬜ | ⬜ | ✅ |
| 4.7 | Unanswerable-from-fixtures question | "Will my premium go up?" — must refuse to hallucinate | ⬜ | ⬜ | ⬜ |
| 4.8 | Switching claims mid-conversation | Switch between dental/healthcare claims mid-call | ⬜ | ⬜ | ✅ |
| 4.9 | Soft wrap-up check-in, decline | | ⬜ | ⬜ | ✅ |
| 4.10 | Soft wrap-up check-in, accept | | ⬜ | ⬜ | ✅ |
| 5.1 | One off-topic question | | ⬜ | ⬜ | ✅ |
| 5.2 | Two in a row → transfer offer | | ⬜ | ⬜ | ✅ |
| 5.3 | Streak reset | Off-topic → in-scope → off-topic again | ✅ | ⬜ | ⬜ |
| 5.4 | Off-topic during VERIFY_ID specifically | | ⬜ | ⬜ | ✅ |
| 5.5 | Accept the transfer offer | | ⬜ | ⬜ | ✅ |
| 5.6 | Decline the transfer offer | | ✅ | ⬜ | ⬜ |
| 6.1 | The exact spec example | Frustrated refusal, de-escalation — matches the spec's worked example | ⬜ | ✅ | ✅ |
| 6.2 | Escalating refusal → proactive transfer offer | | ⬜ | ⬜ | ✅ |
| 6.3 | Accept the transfer from 6.2 | | ⬜ | ⬜ | ✅ |
| 6.4 | Anxious/confused tone | "Is my information safe?" | ✅ | ⬜ | ✅ |
| 6.5 | Frustration during PROCESS_CASE | | ⬜ | ⬜ | ✅ |
| 6.6 | De-escalation after calming down | Tone shouldn't over-persist once calm | ✅ | ⬜ | ✅ |
| 7.1 | Explicit closing signal | | ⬜ | ⬜ | ✅ |
| 7.2 | Accept the email offer | | ⬜ | ✅ | ✅ |
| 7.3 | Decline/skip the email offer | | ✅ | ⬜ | ✅ |
| 7.4 | Summary accuracy | Recap reflects the real denial reason, documents, and deadline | ⬜ | ✅ | ✅ |
| 7.5 | Turn-count safety net guarantee | | ⬜ | ⬜ | ✅ |
| 8.1 | ESCALATED persists | | ⬜ | ⬜ | ✅ |
| 8.2 | DONE persists | | ⬜ | ⬜ | ✅ |
| 9.1 | The complete spec sample scenario | Full spec sample end-to-end, every stated expectation | ⬜ | ✅ | ✅ |
| 9.2 | Reset button (actual UI button) | Click the real reset button in a browser | ✅ | ⬜ | ⬜ |
| 9.3 | Debug sidebar correctness | Every phase-conditional section renders/hides correctly | ✅ | ⬜ | ⬜ |
| 9.4 | Docker deployment | | ⬜ | ⬜ | ✅ |
| 9.5 | Fresh setup sanity | Fresh-clone-and-follow-the-README pass | ⬜ | ⬜ | ✅ |
| 9.6 | Page refresh doesn't lose/misrepresent state | | ⬜ | ⬜ | ✅ |
| 10.1 | LLM failure fallback | | ⬜ | ⬜ | ✅ |
| 10.2 | Garbled/weird input | Emojis, empty string, whitespace, very long input | ✅ | ⬜ | ✅ |
| 10.3 | Everything-at-once stress test | Identity + emotion + two claims + a direct question, all in one message | ✅ | ✅ | ⬜ |
| 11.1 | Rep gives policyholder's fields but not their own name | Should ask for the rep's own name before proceeding | ✅ | ⬜ | ⬜ |
| 11.2 | Recognized representative, consent approved | David Chen calling on behalf of Margaret Chen | ⬜ | ⬜ | ✅ |
| 11.3 | Caller isn't an authorized rep | Same message as "John Smith" instead of David Chen | ⬜ | ⬜ | ✅ |
| 11.4 | Recognized rep, consent not confirmed | `CONSENT_SCENARIO=timeout` | ⬜ | ⬜ | ✅ |
| 11.5 | Ordinary policyholder call unaffected (regression) | The rep gate only engages when `callerRole` is explicitly "representative" | ✅ | ⬜ | ⬜ |
| 11.6 | Policyholder tries to enroll a new representative herself | "Give access to John Smith, my son, to all my claims." | ⬜ | ⬜ | ✅ |
