import type { GetStateResponse, ResetResponse, SendMessageResponse } from "./types";

async function parseJsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed with status ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function sendMessage(message: string): Promise<SendMessageResponse> {
  const res = await fetch("/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message })
  });
  return parseJsonOrThrow<SendMessageResponse>(res);
}

export async function resetConversation(): Promise<ResetResponse> {
  const res = await fetch("/reset", { method: "POST" });
  return parseJsonOrThrow<ResetResponse>(res);
}

export async function getConversationState(): Promise<GetStateResponse> {
  const res = await fetch("/state");
  return parseJsonOrThrow<GetStateResponse>(res);
}
