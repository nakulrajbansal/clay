import { ClayError } from "./errors";

const invalid = (): never => { throw new ClayError("E_VALIDATION", "Reviewed automation input is not a closed V2 definition"); };
function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) return invalid();
  return input as Record<string, unknown>;
}
const table = (input: unknown) => object(input, ["tableId", "lastKnownName"]);
const field = (input: unknown) => object(input, ["tableId", "fieldId", "lastKnownName"]);
/** Shape closure before normalization. This receives coordinator-captured JSON;
 * semantic resolution, scalar validation and bounds stay in the existing engine. */
export function assertClosedAutomationDraftInput(input: unknown): void {
  const value = object(input, ["v", "id", "name", "recipe", "trigger", "actions", "runtime"]);
  object(value.runtime, ["mode", "timeZone", "missedPolicy"]);
  if (value.recipe !== undefined) object(value.recipe, ["id", "version"]);
  if (!value.trigger || typeof value.trigger !== "object" || Array.isArray(value.trigger)) invalid();
  const kind = (value.trigger as Record<string, unknown>).kind;
  if (kind === "schedule") {
    const trigger = object(value.trigger, ["kind", "cadence", "localTime", "weekday"]);
    if (trigger.cadence !== "weekly" && Object.hasOwn(trigger, "weekday")) invalid();
  } else {
    const trigger = object(value.trigger, kind === "date_due" ? ["kind", "table", "conditions", "dateField", "daysBefore"] : ["kind", "table", "conditions"]);
    table(trigger.table); if (kind === "date_due") field(trigger.dateField);
    if (!Array.isArray(trigger.conditions)) invalid();
    for (const entry of trigger.conditions as unknown[]) { const condition = object(entry, ["field", "op", "value"]); field(condition.field); }
  }
  if (!Array.isArray(value.actions)) invalid();
  for (const entry of value.actions as unknown[]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid();
    const actionKind = (entry as Record<string, unknown>).kind;
    if (actionKind === "notify") { object(entry, ["kind", "title", "body"]); continue; }
    const action = object(entry, actionKind === "set_fields" ? ["kind", "values"]
      : actionKind === "create_record" ? ["kind", "table", "values"]
      : actionKind === "create_related" ? ["kind", "table", "relationField", "values"] : []);
    if (actionKind !== "set_fields") table(action.table);
    if (actionKind === "create_related") field(action.relationField);
    if (!Array.isArray(action.values)) invalid();
    for (const raw of action.values as unknown[]) {
      const assignment = object(raw, ["field", "value"]); field(assignment.field);
      const source = object(assignment.value, ["source", "field", "value"]);
      object(source, source.source === "literal" ? ["source", "value"] : ["source", "field"]);
    }
  }
}
