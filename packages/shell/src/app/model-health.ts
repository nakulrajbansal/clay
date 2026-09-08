import { readBoundedResponseText } from "@clay/mutation/bounded-response";

export const MODEL_HEALTH_RESPONSE_MAX_BYTES = 16 * 1024;
export const MODEL_HEALTH_TIMEOUT_MS = 2_500;

type HealthFetch = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<Pick<Response, "ok" | "status" | "body" | "headers">>;

export async function fetchModelHealth(
  url: string,
  options: { fetchFn?: HealthFetch; timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; value: unknown }> {
  const timeoutMs = options.timeoutMs ?? MODEL_HEALTH_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MODEL_HEALTH_TIMEOUT_MS)
    throw new TypeError("model health timeout is invalid");
  const fetchFn = options.fetchFn
    ?? ((input: string, init: { signal: AbortSignal }) => fetch(input, init));
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() =>
    controller.abort(new Error("model health deadline exceeded")), timeoutMs);
  try {
    const response = await fetchFn(url, { signal: controller.signal });
    const text = await readBoundedResponseText(response, MODEL_HEALTH_RESPONSE_MAX_BYTES);
    return { ok: response.ok, status: response.status, value: JSON.parse(text) as unknown };
  } finally {
    globalThis.clearTimeout(timer);
  }
}
