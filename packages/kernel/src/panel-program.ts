// These are the only parser modes used by durable panel validation and rename.
// No tokenizer, plugin, callback or caller-supplied parser options cross this API.
import { parse, type Node } from "acorn";
export type PanelProgramNode = Node;
export const parseValidatedPanel = (code: string): Node =>
  parse(code, { ecmaVersion: 2023, sourceType: "module" });
export const parseRewritablePanel = (code: string): Node =>
  parse(code, { ecmaVersion: "latest", sourceType: "module" });
