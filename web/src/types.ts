export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface DebugInfo {
  matchedFields: string[];
  verified: boolean;
  memory: {
    intentHint?: string;
    caseTypeHint?: string;
    caseIdHint?: string;
  };
  lastEmotion: string;
  offTopicStreak: number;
  resolvedCaseId?: string;
  emailDecision?: "sent" | "skipped";
  callerRole?: "policyholder" | "representative";
  representativeName?: string;
  representativeAuthorized?: boolean;
}

export interface SendMessageResponse {
  reply: string;
  phase: string;
  debug: DebugInfo;
}

export interface ResetResponse {
  phase: string;
}

export interface GetStateResponse {
  phase: string;
  messages: ChatMessage[];
  debug: DebugInfo;
}
