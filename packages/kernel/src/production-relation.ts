import { z } from "zod";
import { TargetEvidenceV1 } from "@clay/schema/catalog";
import { ClayError } from "./errors";
import { PRODUCTION_STORE_PRIMITIVES, type ClayStore } from "./store";

const name = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/);
export const RelationPreviewRequest = z.object({
  sourceTable: name, sourceField: name, targetTable: name, displayField: name,
}).strict();
const count = z.number().int().nonnegative().max(5_000);
export const RelationKeepRequest = RelationPreviewRequest.extend({
  atVersion: z.number().int().nonnegative().safe(), fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  matchedRows: count, unmatchedRows: count, ambiguousRows: count, duplicateSourceRows: count,
  unmatchedSamples: z.array(z.string().max(64_000)).max(5),
  ambiguousSamples: z.array(z.string().max(64_000)).max(5),
  cardinality: z.literal("one"), authorityTarget: TargetEvidenceV1,
}).strict();
export type CapturedRelationKeep = z.infer<typeof RelationKeepRequest>;

export function keepRelation(store: ClayStore, input: CapturedRelationKeep, target: TargetEvidenceV1) {
  if (JSON.stringify(input.authorityTarget) !== JSON.stringify(TargetEvidenceV1.parse(target)))
    throw new ClayError("E_CONFLICT", "conversion preview target changed; preview again");
  const current = PRODUCTION_STORE_PRIMITIVES.previewRelationConversion.call(store, {
    sourceTable: input.sourceTable, sourceField: input.sourceField,
    targetTable: input.targetTable, displayField: input.displayField,
  });
  for (const key of Object.keys(current) as Array<keyof typeof current>)
    if (JSON.stringify(current[key]) !== JSON.stringify(input[key]))
      throw new ClayError("E_CONFLICT", "conversion preview changed; preview again");
  return PRODUCTION_STORE_PRIMITIVES.convertTextToRelation.call(store, input);
}
