import { z } from "./validation-runtime";
import { UInt64Decimal } from "./index";
import { TargetEvidenceV1 } from "./catalog";

// Ephemeral CPU work, not a mutation/receipt/request-journal contract.
export const StarterIdV1 = z.enum(["blank", "tracker", "log", "dashboard", "small_business",
  "crm", "financials", "staff", "habits", "inventory", "approvals", "jobs", "content", "okrs", "events", "library"]);
export const ComputeSourceV1 = z.object({ catalogGeneration: UInt64Decimal, target: TargetEvidenceV1 }).strict();
export type ComputeSourceV1 = z.infer<typeof ComputeSourceV1>;
export const ComputeRequestV1 = z.object({ v: z.literal(1), kind: z.literal("starter"),
  nonce: z.string().regex(/^[0-9a-f]{64}$/), starter: StarterIdV1, source: ComputeSourceV1 }).strict();
export type ComputeRequestV1 = z.infer<typeof ComputeRequestV1>;
export const ComputeReplyV1 = ComputeRequestV1.extend({ fragment: z.string().min(1).max(900_000) }).strict();
export type ComputeReplyV1 = z.infer<typeof ComputeReplyV1>;
