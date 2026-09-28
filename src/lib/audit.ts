export type AuditEvent = {
  requestId: string;
  startedAt: number;
  ipMasked: string;
  sessionHash: string | null;
  inputChars: number;
  imageBytes: number;
  turnstileSuccess: boolean;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  estimatedUsdCents: number;
  outcome: "success" | "reject" | "error";
  reason: string;
  prompt?: string;
};

export function audit(event: AuditEvent) {
  const { startedAt, ...fields } = event;
  console.info(JSON.stringify({
    event: "ROOM_DESIGN_ATTEMPT",
    timestamp: new Date().toISOString(),
    route: "/api/room-design",
    latencyMs: Date.now() - startedAt,
    ...fields,
  }));
}
