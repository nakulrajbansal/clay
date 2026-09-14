import type { z } from "zod";
export interface Parser<T> {
  parse(value: unknown): T;
  safeParse(value: unknown): { success: true; data: T; error?: never } | { success: false; error: StandaloneError; data?: never };
}
export type Compiled<T extends z.ZodTypeAny> = Parser<z.output<T>> & (T extends z.ZodEnum<infer V> ? { readonly options: V } : {});
export class StandaloneError extends Error { issues: z.ZodIssue[]; readonly errors: z.ZodIssue[]; }
export function standalone<T>(node: unknown): Parser<T>;
