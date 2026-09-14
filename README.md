# Insurance Claims SOP Agent

An SOP-governed insurance claims support agent for a phone-style chat
support flow. A fixed workflow (`VERIFY_ID` → `RESOLVE_INTENT` →
`PROCESS_CASE` → `POST_PROCESS`, plus terminal `ESCALATED`/`DONE` states) is enforced by code — not by the LLM — while natural conversation, empathy, and grounded reasoning are layered on top wherever the SOP allows freedom.

See [`DECISIONS.md`](./DECISIONS.md) for the full log of design decisions,
scope calls, and bugs found/fixed along the way, each with the options
considered and the reasoning behind the choice made.

## Structure

```
fixtures/            sample policyholders, claims, and document guidance data (provided)
server/
  src/
    sop/              phase state machine + per-phase handlers
    llm/              provider-agnostic LLM interface (Groq default, Gemini also supported)
    tools/            fixture-backed lookups (identity matching, claims, document guidance)
    memory/           per-turn structured extraction (PII, intent hints, emotion, in-scope flag)
    guardrails/       scope/off-topic enforcement, closing-signal + transfer-acceptance detection
    session/          single fixed in-memory conversation state + reset
    api/              Express routes (POST /message, POST /reset, GET /health, GET /state) + serves the built UI
  tests/              mocked (fast, free, deterministic) + live (real API) test suites
web/
  src/                React chat test UI (chat window + phase-aware debug sidebar)
  tests/              component tests (Vitest + React Testing Library)
Dockerfile, docker-compose.yml
```

## Running it

### Option A — Docker (single command, closest to production)

```bash
cp server/.env.example server/.env   # then fill in GROQ_API_KEY (see below)
docker compose up --build
```

Open **http://localhost:4000** — the container serves both the API and the
built React UI from one port.

### Option B — local dev (two processes, hot reload)

Requires Node.js 20+.

```bash
# Terminal 1 — backend
cd server
cp .env.example .env   # then fill in GROQ_API_KEY
npm install
npm run dev             # http://localhost:4000

# Terminal 2 — frontend
cd web
npm install
npm run dev              # http://localhost:5173 — proxies API calls to :4000
```

Open **http://localhost:5173** for the UI with hot reload.

## Configuring the LLM provider / API key

The server reads credentials from `server/.env` (see `server/.env.example`
for the full list of variables). **You need to provide your own API key.**

Default provider is **Groq's free tier**:

1. Get a free API key at https://console.groq.com/keys.
2. Set `GROQ_API_KEY=...` in `server/.env`.

Gemini is also supported (`LLM_PROVIDER=gemini` + `GEMINI_API_KEY=...`), but is **not** the default — see `DECISIONS.md` #1 for why (its current free-tier flash models hit a hard 20 requests/day cap, which made it unworkable for iterative testing). The LLM call sits behind a
provider-agnostic interface (`server/src/llm/`), so adding another provider is a matter of writing one more adapter and setting `LLM_PROVIDER`.

## Running the tests

### Via Docker (no local `npm install` needed)

`--build` makes Docker check for source changes and rebuild the test image
if needed before running — without it, `docker compose run` silently reuses
whatever image was last built, which can run stale code.

```bash
docker compose run --build --rm test               # server: mocked LLM — fast, free, deterministic (the default/primary suite)
docker compose run --build --rm test npm run test:live  # server: real Groq API calls — needs GROQ_API_KEY in server/.env
docker compose run --build --rm web-test           # web: component tests (Vitest + React Testing Library)
```

### Locally

If you followed Option A (Docker) instead of Option B, `server/node_modules`
won't exist on your host yet — Docker installs dependencies inside the
container image only, not on your machine. Run `npm install` first:

```bash
cd server
npm install         # skip if you already ran this as part of Option B
npm test            # mocked LLM — fast, free, deterministic (the default/primary suite)
npm run test:live   # real Groq API calls — looser assertions, consumes API quota, slower
```

The frontend has its own component test suite (Vitest + React Testing Library):

```bash
cd web
npm install   # skip if you already ran this as part of Option B
npm test
```

## What it does

The core design challenge is that each part of the system needs a different amount of freedom. Some must be strict, code-enforced gates; others benefit from the LLM's judgment. The first four rows are the fixed workflow phases, the rest are cross-cutting behaviors that apply across phases:

| Phase | Description | Freedom |
| --- | --- | --- |
| `VERIFY_ID` | A hard, deterministic gate. The caller must match at least 3 of 5 identity fields (full name, DOB, phone, email, last 4 of SSN/ID) against `fixtures/policyholders.json` before anything about their claim is discussed. | **None on the gate itself.** The LLM handles the conversation — asking for missing fields, handling partial/refused answers, empathy, de-escalation — but never decides whether the caller is verified and never discloses claim data. Verification status is computed in code; the LLM only phrases around it. |
| `RESOLVE_INTENT` | Once verified, figures out which of the caller's claims they mean, preferring hints volunteered earlier in the call (even during `VERIFY_ID`) over asking from scratch. | **High on interpretation, none on the outcome.** The LLM interprets messy, ambiguous language to help identify intent, and freely phrases the clarifying question when one's needed — but *whether* a match is unambiguous enough to resolve is a deterministic scoring rule, not an LLM guess. It can never resolve to a claim it isn't entitled to guess. |
| `PROCESS_CASE` | Answers questions about the resolved claim using only facts pulled from `fixtures/claims.json` and `fixtures/required_document_guideline.json`. | **High on phrasing, none on facts.** The LLM interprets the caller's question however it's actually asked and composes a natural answer, but is bounded to the grounded facts it's given — it can never invent a status, amount, reason, or contact detail. |
| `POST_PROCESS` | Summarizes the call and offers a (mocked) emailed summary; the caller can accept or skip. | **Hybrid, and validated.** The required facts (status, outcome, follow-up items for every claim discussed) are always deterministically correct as a guaranteed floor. The LLM is given real freedom on top of that floor — to weave in conversation-specific detail and phrase the recap naturally — but its output is validated before use and discarded in favor of the deterministic version if it drops a required fact. |
| Out-of-scope guardrail | Off-topic questions get a polite redirect; after 2 consecutive off-topic turns, the agent offers a human transfer. | **Moderate on classification, none on the trigger.** The LLM classifies whether a message is in-scope and phrases the redirect, but the redirect-then-escalate counting and threshold are deterministic — the LLM never decides when to actually offer a transfer. |
| Emotional support / de-escalation | Frustration, anxiety, anger, confusion, or refusal is detected each turn and acknowledged before the agent pushes the workflow forward; a caller who keeps refusing to verify gets offered alternate ID fields, then a human transfer. | **High on phrasing, none on the persuasion cutoff.** The LLM detects emotion and composes the empathetic response, but the turn-count threshold for when to stop persuading and lean into a human-transfer offer is deterministic, not a judgment call — and it can never use empathy as a reason to skip verification or disclose anything. |
| Human transfer / call end | Accepting a transfer offer, or completing the post-call email decision, ends the conversation in a terminal state (`ESCALATED` or `DONE`) with a fixed closing message. | **None on the transition.** Whether the caller accepted the offer, or chose yes/skip on the email, is checked with a deterministic keyword match before any LLM call — the LLM only ever phrases the offer or farewell, never decides the state transition itself. |
| Authorized representatives | A caller phoning in on a policyholder's behalf (e.g. a family member) can verify using the *policyholder's* identity fields plus their own name; the system then checks `fixtures/representatives.json` for a matching authorized representative and simulates a consent/authorization check (`fixtures/consent_scenarios.json`) before proceeding. See `DECISIONS.md` #23 for the full design and `CONSENT_SCENARIO` in `.env.example` to demo the denied/timeout path. | **Low.** The LLM's only real judgment call is extracting whether the caller is a representative and their name from natural phrasing (e.g. "calling on behalf of my mother") — whether that representative is authorized and whether consent is confirmed are both deterministic lookups against fixture data. |

## Implementation notes

`fixtures/consent_scenarios.json`'s scenario names (`"default"`/`"timeout"`)
aren't tied to a specific representative or call in the fixture data — which
scenario applies is a demo/test override (`CONSENT_SCENARIO` env var), not
data-driven business logic. The representative + consent flow itself is
fully implemented (see above) — this only describes how the demo selects
which of the two outcomes to simulate. See `DECISIONS.md` #23 for the full
reasoning.

Email sending is mocked (logged, not actually sent) rather than dispatched
through a real SMTP/email provider — a deliberate choice so the setup
doesn't require email credentials for a demo. See `DECISIONS.md` #3.
