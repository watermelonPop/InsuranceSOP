import type { Emotion } from "../state.js";

/** Shared emotion-acknowledgment instruction used by phases beyond VERIFY_ID (which has its own richer version). */
export function emotionAcknowledgmentLine(emotion: Emotion): string | undefined {
  if (emotion === "neutral") return undefined;
  return `The caller's detected emotional tone this turn is "${emotion}." Briefly and genuinely acknowledge that before answering — don't just launch into facts.`;
}
