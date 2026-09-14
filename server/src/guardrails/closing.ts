/**
 * Cheap deterministic check for whether the caller is signaling they're done
 * with PROCESS_CASE (ready to wrap up), so POST_PROCESS can start immediately
 * in the same reply rather than waiting for another turn.
 */
export function isClosingSignal(message: string): boolean {
  const m = message.trim().toLowerCase();
  return /\b(that'?s all|that is all|nothing else|no other questions|i'?m done|i am done|that'?s it|that is it|no thank you|no thanks|thanks that'?s it|bye|goodbye|have a good day)\b/.test(
    m
  );
}
