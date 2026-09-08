export type StrictJson =
  | null | boolean | number | string | StrictJson[] | { [key: string]: StrictJson };
export type StrictJsonCaptureBudget = { nodes: number; bytes: number };
export type StrictJsonCapturePolicy = readonly [
  maxDepth: number,
  maxNodes: number,
  maxStringLength: number,
  maxBytes: number,
  maxArrayLength: number,
  maxRecordKeys: number,
  maxKeyLength: number,
  exactJsonBytes: boolean,
  freeze: boolean,
  fail: (reason: number) => never,
];

export const UTF8_ENCODER = new TextEncoder();

function spend(policy: StrictJsonCapturePolicy, budget: StrictJsonCaptureBudget, bytes: number): void {
  budget.bytes += bytes;
  if (!Number.isSafeInteger(budget.bytes) || budget.bytes > policy[3]) throw policy[9](1);
}

/**
 * Descriptor-safe JSON capture shared by planner and production authority.
 * It never invokes caller accessors, iteration hooks, or array methods.
 */
export function captureStrictJson(
  input: unknown,
  policy: StrictJsonCapturePolicy,
  seen: WeakSet<object> = new WeakSet(),
  budget: StrictJsonCaptureBudget = { nodes: 0, bytes: 0 },
  depth = 0,
): StrictJson {
  if (depth > policy[0] || ++budget.nodes > policy[1]) throw policy[9](0);
  if (input === null) {
    spend(policy, budget, policy[7] ? 4 : 1);
    return null;
  }
  if (typeof input === "boolean") {
    spend(policy, budget, policy[7] ? (input ? 4 : 5) : 1);
    return input;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw policy[9](5);
    spend(policy, budget, policy[7] ? JSON.stringify(input).length : 1);
    return input;
  }
  if (typeof input === "string") {
    if (input.length > policy[2]) throw policy[9](2);
    spend(policy, budget, policy[7]
      ? UTF8_ENCODER.encode(JSON.stringify(input)).byteLength : input.length);
    return input;
  }
  if (typeof input !== "object") throw policy[9](6);
  if (seen.has(input)) throw policy[9](7);
  seen.add(input);
  try {
    if (Array.isArray(input)) {
      if (Reflect.getPrototypeOf(input) !== Array.prototype) throw policy[9](8);
      const keys = Reflect.ownKeys(input);
      const descriptor = Reflect.getOwnPropertyDescriptor(input, "length");
      const rawLength: unknown = descriptor && "value" in descriptor ? descriptor.value : -1;
      if (typeof rawLength !== "number" || !Number.isSafeInteger(rawLength)
          || rawLength < 0 || rawLength > policy[4]) throw policy[9](3);
      const length = rawLength;
      if (keys.length !== length + 1 || keys.some(key => {
        if (key === "length") return false;
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)) return true;
        const index = Number(key);
        return !Number.isSafeInteger(index) || index < 0 || index >= length;
      })) throw policy[9](9);
      spend(policy, budget, policy[7] ? 2 + Math.max(0, length - 1) : length);
      const output = new Array<StrictJson>(length);
      for (let index = 0; index < length; index++) {
        const item = Reflect.getOwnPropertyDescriptor(input, String(index));
        if (!item || !("value" in item) || !item.enumerable) throw policy[9](10);
        output[index] = captureStrictJson(item.value, policy, seen, budget, depth + 1);
      }
      return policy[8] ? Object.freeze(output) as StrictJson[] : output;
    }
    const prototype = Reflect.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw policy[9](11);
    const keys = Reflect.ownKeys(input);
    if (keys.length > policy[5]
        || keys.some(key => typeof key !== "string" || key.length > policy[6])) throw policy[9](4);
    if (policy[7]) spend(policy, budget, 2 + Math.max(0, keys.length - 1));
    const output: { [key: string]: StrictJson } = Object.create(null);
    for (const key of keys as string[]) {
      const item = Reflect.getOwnPropertyDescriptor(input, key);
      if (!item || !("value" in item) || !item.enumerable) throw policy[9](12);
      spend(policy, budget, policy[7]
        ? UTF8_ENCODER.encode(JSON.stringify(key)).byteLength + 1 : key.length);
      output[key] = captureStrictJson(item.value, policy, seen, budget, depth + 1);
    }
    return policy[8] ? Object.freeze(output) : output;
  } finally {
    seen.delete(input);
  }
}
