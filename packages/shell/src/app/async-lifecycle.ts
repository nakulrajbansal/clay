export function createRetryingLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return (): Promise<T> => {
    if (pending) return pending;
    let current!: Promise<T>;
    current = Promise.resolve().then(load).catch(error => {
      if (pending === current) pending = null;
      throw error;
    });
    pending = current;
    return current;
  };
}

export function beginLazySession<T>(
  load: () => Promise<T>,
  start: (value: T, isActive: () => boolean) => () => void,
  onError: (error: unknown) => void,
): () => void {
  let active = true;
  let stopCurrent: () => void = () => undefined;
  void load().then(value => {
    if (!active) return;
    stopCurrent = start(value, () => active);
  }).catch(error => {
    if (active) onError(error);
  });
  return () => {
    if (!active) return;
    active = false;
    stopCurrent();
  };
}

export class LatestRequestGate {
  #current: object = Object.freeze({});

  begin(): object {
    const token = Object.freeze({});
    this.#current = token;
    return token;
  }

  isCurrent(token: object): boolean {
    return token === this.#current;
  }

  invalidate(): void {
    this.#current = Object.freeze({});
  }
}

export async function runLatestRequest<T>(
  gate: LatestRequestGate,
  load: () => Promise<T>,
  apply: (value: T) => void,
): Promise<"applied" | "stale"> {
  const generation = gate.begin();
  let value: T;
  try {
    value = await load();
  } catch (error) {
    if (!gate.isCurrent(generation)) return "stale";
    throw error;
  }
  if (!gate.isCurrent(generation)) return "stale";
  apply(value);
  return "applied";
}
