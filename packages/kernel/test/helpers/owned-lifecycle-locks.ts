/** Disposable serialized exclusion for owned fixtures, never a production fallback. */
export function ownedLifecycleLocks() {
  let tail: Promise<unknown> = Promise.resolve();
  return { request: <T>(_name: string, options: { mode: string }, work: () => Promise<T>): Promise<T> => {
    if (options.mode !== "exclusive") throw new Error("Owned lifecycle fixture requires exclusive mode");
    const result = tail.then(work); tail = result.catch(() => undefined); return result;
  } };
}
