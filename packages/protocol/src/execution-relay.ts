import { z } from "zod";

export const RelayAddressSchema = z.object({ serverId: z.string(), agentId: z.string() });
export const RelayMemberSchema = z.object({
  address: RelayAddressSchema,
  title: z.string(),
  host: z.string().optional(),
  provider: z.enum(["claude", "codex"]),
  status: z.enum(["queued", "starting", "running", "completed", "canceled", "invalid"]),
  planRequestId: z.string().nullable(),
  planHash: z.string().nullable(),
  turnId: z.string().nullable(),
});
export const RelayGroupSchema = z.object({
  id: z.string(),
  paused: z.boolean(),
  reason: z.string().nullable(),
  members: z.array(RelayMemberSchema),
});
export const RelayCandidateSchema = z.object({
  address: RelayAddressSchema,
  title: z.string(),
  host: z.string(),
  provider: z.enum(["claude", "codex"]),
  state: z.enum(["running", "plan"]),
});
export const RelayStateSchema = z.object({
  groups: z.array(RelayGroupSchema),
  candidates: z.array(RelayCandidateSchema),
  unavailableHosts: z.array(z.string()),
});
export const RelayGetStateRequestSchema = z.object({
  type: z.literal("execution.relay.get_state.request"),
  requestId: z.string(),
});
export const RelayJoinRequestSchema = z.object({
  type: z.literal("execution.relay.join.request"),
  requestId: z.string(),
  source: RelayAddressSchema,
  planRequestId: z.string(),
  target: RelayAddressSchema,
});
export const RelayUpdateRequestSchema = z.object({
  type: z.literal("execution.relay.update.request"),
  requestId: z.string(),
  member: RelayAddressSchema,
  action: z.enum(["pause", "resume", "leave"]),
});
const reply = z.object({
  requestId: z.string(),
  error: z.string().nullable(),
  state: RelayStateSchema.nullable(),
});
export const RelayGetStateResponseSchema = z.object({
  type: z.literal("execution.relay.get_state.response"),
  payload: reply,
});
export const RelayJoinResponseSchema = z.object({
  type: z.literal("execution.relay.join.response"),
  payload: reply,
});
export const RelayUpdateResponseSchema = z.object({
  type: z.literal("execution.relay.update.response"),
  payload: reply,
});

export type RelayAddress = z.infer<typeof RelayAddressSchema>;
export type RelayMember = z.infer<typeof RelayMemberSchema>;
export type RelayGroup = z.infer<typeof RelayGroupSchema>;
export type RelayCandidate = z.infer<typeof RelayCandidateSchema>;
export type RelayState = z.infer<typeof RelayStateSchema>;
