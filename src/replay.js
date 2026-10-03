const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);
const REPLAYABLE_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
const MAX_RESPONSE_PREVIEW_BYTES = 8192;

async function readPreview(response) {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    while (total < MAX_RESPONSE_PREVIEW_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_RESPONSE_PREVIEW_BYTES - total;
      const kept = value.subarray(0, remaining);
      chunks.push(Buffer.from(kept));
      total += kept.byteLength;
      if (value.byteLength > remaining) {
        truncated = true;
        break;
      }
    }
    if (!truncated && total === MAX_RESPONSE_PREVIEW_BYTES) {
      const next = await reader.read();
      truncated = !next.done;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

export async function replayCapture(capture, target, fetchImpl = fetch) {
  if (!REPLAYABLE_METHODS.has(capture.method)) {
    const error = new Error(
      `Method ${capture.method} is not supported for replay.`,
    );
    error.statusCode = 400;
    throw error;
  }
  const headers = new Headers();
  for (const header of capture.headers) {
    const name = header.name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name) || header.value === "[REDACTED]") continue;
    headers.append(header.name, header.value);
  }
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetchImpl(target.url, {
      method: capture.method,
      headers,
      body: ["GET", "HEAD"].includes(capture.method) ? undefined : capture.body,
      redirect: "manual",
      signal: controller.signal,
    });
    const preview = await readPreview(response);
    const responseHeaders = [];
    for (const [name, value] of response.headers) {
      responseHeaders.push({
        name,
        value:
          /set-cookie|authorization|token|secret|password|api[-_]?key/i.test(
            name,
          )
            ? "[REDACTED]"
            : value,
      });
    }
    return {
      targetId: target.id,
      targetLabel: target.label,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      status: response.status,
      statusText: response.statusText,
      redirected: response.status >= 300 && response.status < 400,
      headers: responseHeaders,
      preview: preview.text,
      previewTruncated: preview.truncated,
    };
  } finally {
    clearTimeout(timeout);
  }
}
