export class BoundedResponseTextError extends Error {
  readonly code: "BODY_TOO_LARGE" | "INVALID_UTF8" | "INVALID_BODY";

  constructor(code: "BODY_TOO_LARGE" | "INVALID_UTF8" | "INVALID_BODY", message: string) {
    super(message);
    this.name = "BoundedResponseTextError";
    this.code = code;
  }
}

async function cancelQuietly(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
): Promise<void> {
  try { await reader.cancel(reason); } catch { /* the transport may already be closed */ }
}

export async function readBoundedResponseText(
  response: Pick<Response, "body" | "headers">,
  maxBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new BoundedResponseTextError("INVALID_BODY", "response byte limit is invalid");
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^(?:0|[1-9][0-9]*)$/.test(contentLength)
      && Number(contentLength) > maxBytes) {
    try { await response.body?.cancel(); } catch { /* best-effort transport release */ }
    throw new BoundedResponseTextError(
      "BODY_TOO_LARGE", `response body exceeds ${maxBytes} bytes`,
    );
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let totalBytes = 0;
  let text = "";
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { completed = true; break; }
      if (!(value instanceof Uint8Array)) {
        const error = new BoundedResponseTextError(
          "INVALID_BODY", "response stream returned a non-byte chunk",
        );
        await cancelQuietly(reader, error);
        throw error;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        const error = new BoundedResponseTextError(
          "BODY_TOO_LARGE", `response body exceeds ${maxBytes} bytes`,
        );
        await cancelQuietly(reader, error);
        throw error;
      }
      try {
        text += decoder.decode(value, { stream: true });
      } catch (cause) {
        const error = new BoundedResponseTextError(
          "INVALID_UTF8", "response body is not valid UTF-8",
        );
        await cancelQuietly(reader, cause);
        throw error;
      }
    }
    try {
      text += decoder.decode();
    } catch (cause) {
      throw new BoundedResponseTextError(
        "INVALID_UTF8", "response body is not valid UTF-8",
      );
    }
    return text;
  } finally {
    if (!completed) await cancelQuietly(reader, "bounded response read stopped");
    try { reader.releaseLock(); } catch { /* ignored */ }
  }
}
