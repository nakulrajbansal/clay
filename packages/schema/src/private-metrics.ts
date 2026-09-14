import { z } from "./validation-runtime";
import { DiffKind as PlanDiffKindSchema } from "./index";
export const DurationBucketSchema = z.enum([
  "under_3m", "3_to_10m", "10_to_30m", "over_30m",
]);
export const SafeDiffKindSchema = z.enum([
  ...PlanDiffKindSchema.options,
  "mixed",
  "unknown",
]);
export const PrivateMetricEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("app_ready"),
    entry: z.enum([
      "new_blank", "new_starter", "data_import", "archive_import", "existing",
    ]),
  }).strict(),
  z.object({
    type: z.literal("activation_completed"),
    elapsed: DurationBucketSchema,
  }).strict(),
  z.object({
    type: z.literal("reshape_started"),
    origin: z.enum(["composer", "observer_suggestion", "panel_repair"]),
  }).strict(),
  z.object({
    type: z.literal("reshape_finished"),
    outcome: z.enum(["preview", "clarify", "failed"]),
    repaired: z.boolean(),
    stage: z.enum(["none", "plan", "validate", "dry_run"]),
    diff: SafeDiffKindSchema,
  }).strict(),
  z.object({
    type: z.literal("preview_decided"),
    decision: z.enum(["kept", "discarded"]),
    repaired: z.boolean(),
    diff: SafeDiffKindSchema,
  }).strict(),
  z.object({
    type: z.literal("trust_surface_opened"),
    surface: z.enum(["shape_map", "history", "trust_receipt", "storage_status"]),
  }).strict(),
  z.object({
    type: z.literal("lens_changed"),
    mode: z.enum(["all", "situational"]),
  }).strict(),
  z.object({
    type: z.literal("rewind_finished"),
    source: z.enum(["trust_receipt", "history", "time_slider"]),
    result: z.enum(["success", "cancelled", "failed"]),
    depth: z.enum(["one", "two_to_five", "six_plus"]),
  }).strict(),
  z.object({
    type: z.literal("fault_seen"),
    fault: z.enum(["runtime", "strike_limit", "render_timeout", "unknown"]),
  }).strict(),
  z.object({
    type: z.literal("recovery_finished"),
    method: z.enum(["panel_repair", "panel_revert", "row_restore", "history_rewind"]),
    result: z.enum(["success", "discarded", "failed"]),
  }).strict(),
  z.object({
    type: z.literal("backup_finished"),
    action: z.enum(["export", "import"]),
    result: z.enum(["success", "failed"]),
  }).strict(),
  z.object({
    type: z.literal("proof_loop_completed"),
    elapsed: DurationBucketSchema,
  }).strict(),
]);
export type SafeDiffKind = z.infer<typeof SafeDiffKindSchema>;
export type DurationBucket = z.infer<typeof DurationBucketSchema>;
export type PrivateMetricEvent = z.infer<typeof PrivateMetricEventSchema>;
