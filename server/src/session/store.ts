import { createInitialState, type ConversationState } from "../sop/state.js";

// Single fixed demo session (decision: see DECISIONS.md #6) — one conversation
// state lives on the server at a time, reset via POST /reset.
let state: ConversationState = createInitialState();

export function getState(): ConversationState {
  return state;
}

export function resetState(): ConversationState {
  state = createInitialState();
  return state;
}
