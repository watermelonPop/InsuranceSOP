import type { PhaseHandler } from "./types.js";

export const DONE_MESSAGE = "This call has ended. Thank you for contacting us — have a great day!";

// Terminal state. The engine short-circuits before reaching this handler
// (see sop/engine.ts), but it exists so PHASE_HANDLERS stays total over Phase.
export const handleDone: PhaseHandler = async () => DONE_MESSAGE;
