import { z as library } from "zod";

/** The closed factory vocabulary used by Clay's runtime contracts. These are
 * the original installed Zod functions, not substitute validators. One stable
 * namespace gives independently built shell/worker realms an identical shared
 * asset instead of emitting a different copy of Zod for every subset of imports.
 * No schema instances, parse state or authority are shared between realms. */
export const z = /*#__PURE__*/ Object.freeze({
  array: library.array,
  boolean: library.boolean,
  custom: library.custom,
  discriminatedUnion: library.discriminatedUnion,
  enum: library.enum,
  lazy: library.lazy,
  literal: library.literal,
  null: library.null,
  number: library.number,
  object: library.object,
  record: library.record,
  string: library.string,
  tuple: library.tuple,
  union: library.union,
  unknown: library.unknown,
  ZodIssueCode: library.ZodIssueCode,
});

// Preserve the existing contract authoring types; this namespace emits no code.
export namespace z {
  export type infer<T extends library.ZodTypeAny> = library.infer<T>;
  export type RefinementCtx = library.RefinementCtx;
  export type ZodString = library.ZodString;
  export type ZodTypeAny = library.ZodTypeAny;
  export type ZodType<Output = unknown, Def extends library.ZodTypeDef = library.ZodTypeDef, Input = Output>
    = library.ZodType<Output, Def, Input>;
}
