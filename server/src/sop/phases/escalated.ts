import { ESCALATION_HANDOFF_MESSAGE } from "../../guardrails/escalation.js";
import type { PhaseHandler } from "./types.js";

// Terminal state. In practice the engine short-circuits before ever reaching
// this handler (see sop/engine.ts), but it exists so the PHASE_HANDLERS map
// stays total over the Phase union.
export const handleEscalated: PhaseHandler = async () => ESCALATION_HANDOFF_MESSAGE;
