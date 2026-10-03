import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, redactHeaderName } from "./config.js";
import { CaptureStore } from "./store.js";
import { replayCapture } from "./replay.js";
import { isIP } from "node:net";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
}

function sendJson(response, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value));
  setSecurityHeaders(response);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.byteLength,
  });
  response.end(body);
}

function rawHeadersForStorage(request, additionalRedactedHeaders) {
  const headers = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name === undefined || value === undefined) continue;
    headers.push({
      name,
      value: redactHeaderName(name, additionalRedactedHeaders)
        ? "[REDACTED]"
        : value,
    });
  }
  return headers;
}

async function readBody(request, maximumBytes) {
  const chunks = [];
  let size = 0;
  let exceeded = false;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > maximumBytes) {
      exceeded = true;
      chunks.length = 0;
    } else if (!exceeded) {
      chunks.push(Buffer.from(chunk));
    }
  }
  if (exceeded)
    throw new HttpError(
      413,
      `Request body exceeds the ${maximumBytes} byte limit.`,
    );
  return Buffer.concat(chunks, size);
}

async function readJson(request, maximumBytes) {
  const body = await readBody(request, maximumBytes);
  try {
    const value = JSON.parse(body.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("expected an object");
    return value;
  } catch {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
}

function detailView(capture) {
  const isText =
    !capture.contentType ||
    /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded))/i.test(
      capture.contentType,
    );
  return {
    id: capture.id,
    endpoint: capture.endpoint,
    receivedAt: capture.receivedAt,
    method: capture.method,
    path: capture.path,
    rawQuery: capture.rawQuery,
    query: capture.query,
    headers: capture.headers,
    contentType: capture.contentType,
    bodySize: capture.bodySize,
    bodyText: isText ? capture.body.toString("utf8") : null,
    bodyBase64: capture.body.toString("base64"),
    replay: capture.replay,
  };
}

function validateLimit(value) {
  if (value === null) return 50;
  if (!/^\d+$/.test(value))
    throw new HttpError(400, "limit must be a whole number from 1 to 100.");
  const limit = Number(value);
  if (limit < 1 || limit > 100)
    throw new HttpError(400, "limit must be a whole number from 1 to 100.");
  return limit;
}

async function serveStatic(response, relativePath, contentType) {
  const body = await fs.readFile(
    path.join(PROJECT_ROOT, "public", relativePath),
  );
  setSecurityHeaders(response);
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": body.byteLength,
  });
  response.end(body);
}

export function createHookScope({
  config = loadConfig(),
  fetchImpl = fetch,
  logger = console,
} = {}) {
  const store = new CaptureStore(config);

  async function handle(request, response) {
    let addressedHost;
    try {
      addressedHost = new URL(
        `http://${request.headers.host || ""}`,
      ).hostname.replace(/^\[|\]$/g, "");
    } catch {
      throw new HttpError(403, "Use a local Host header.");
    }
    if (!(
      addressedHost === "localhost" ||
      addressedHost === "::1" ||
      (isIP(addressedHost) === 4 && addressedHost.startsWith("127."))
    ))
      throw new HttpError(403, "Only local request hosts are accepted.");
    if (request.headers["sec-fetch-site"] === "cross-site")
      throw new HttpError(403, "Cross-site requests are blocked.");
    if (request.headers.origin) {
      let origin;
      try {
        origin = new URL(request.headers.origin);
      } catch {
        throw new HttpError(403, "Invalid Origin header.");
      }
      if (
        origin.host.toLowerCase() !== request.headers.host.toLowerCase() ||
        !["http:", "https:"].includes(origin.protocol)
      )
        throw new HttpError(403, "Cross-origin requests are blocked.");
    }
    const method = request.method || "GET";
    let url;
    try {
      url = new URL(request.url || "/", "http://hookscope.local");
    } catch {
      throw new HttpError(400, "Malformed request URL.");
    }
    const pathname = url.pathname;

    if (pathname === "/api/health" && method === "GET")
      return sendJson(response, 200, {
        ok: true,
        maxBodyBytes: config.maxBodyBytes,
      });
    if (pathname === "/api/targets" && method === "GET") {
      return sendJson(response, 200, {
        targets: config.replayTargets.map(({ id, label }) => ({ id, label })),
      });
    }
    if (pathname === "/api/captures" && method === "GET") {
      const endpoint = url.searchParams.get("endpoint") || "";
      const captureMethod = (
        url.searchParams.get("method") || ""
      ).toUpperCase();
      const query = url.searchParams.get("q") || "";
      if (query.length > 200)
        throw new HttpError(400, "q may contain at most 200 characters.");
      if (
        captureMethod.length > 20 ||
        (captureMethod && !/^[A-Z0-9!#$%&'*+.^_`|~-]+$/.test(captureMethod))
      )
        throw new HttpError(400, "method is not a valid HTTP token.");
      return sendJson(response, 200, {
        captures: store.list({
          endpoint,
          method: captureMethod,
          query,
          limit: validateLimit(url.searchParams.get("limit")),
        }),
      });
    }
    if (pathname === "/api/captures" && method !== "GET") {
      response.setHeader("Allow", "GET");
      throw new HttpError(405, "Method not allowed.");
    }
    if (pathname === "/api/captures")
      throw new HttpError(405, "Method not allowed.");

    const replayMatch = /^\/api\/captures\/([0-9a-f-]{36})\/replay$/i.exec(
      pathname,
    );
    if (replayMatch && method === "POST") {
      if (
        !/^application\/json(?:\s*;|$)/i.test(
          request.headers["content-type"] || "",
        )
      )
        throw new HttpError(415, "Use Content-Type: application/json.");
      const input = await readJson(request, 4096);
      if (typeof input.targetId !== "string")
        throw new HttpError(400, "targetId is required.");
      const target = config.replayTargets.find(
        (item) => item.id === input.targetId,
      );
      if (!target)
        throw new HttpError(
          400,
          "targetId is not in the configured replay allowlist.",
        );
      const capture = store.get(replayMatch[1]);
      if (!capture) throw new HttpError(404, "Capture not found.");
      let replay;
      try {
        replay = await replayCapture(capture, target, fetchImpl);
      } catch (error) {
        if (error.statusCode) throw error;
        const message =
          error.name === "AbortError"
            ? "Replay timed out after 5 seconds."
            : "Could not reach the configured replay target.";
        replay = {
          targetId: target.id,
          targetLabel: target.label,
          completedAt: new Date().toISOString(),
          error: message,
        };
        store.saveReplay(capture.id, replay);
        return sendJson(response, 502, { replay });
      }
      store.saveReplay(capture.id, replay);
      return sendJson(response, 200, { replay });
    }

    const captureMatch = /^\/api\/captures\/([0-9a-f-]{36})$/i.exec(pathname);
    if (captureMatch && method === "GET") {
      const capture = store.get(captureMatch[1]);
      if (!capture) throw new HttpError(404, "Capture not found.");
      return sendJson(response, 200, { capture: detailView(capture) });
    }
    if (captureMatch && method === "DELETE") {
      const deleted = store.delete(captureMatch[1]);
      return sendJson(
        response,
        deleted ? 200 : 404,
        deleted ? { deleted: true } : { error: "Capture not found." },
      );
    }
    if (captureMatch) {
      response.setHeader("Allow", "GET, DELETE");
      throw new HttpError(405, "Method not allowed.");
    }

    if (pathname.startsWith("/hooks/")) {
      if (method.length > 20 || !/^[A-Z0-9!#$%&'*+.^_`|~-]+$/.test(method))
        throw new HttpError(400, "Invalid HTTP method.");
      const endpoint = pathname.slice("/hooks/".length);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(endpoint))
        throw new HttpError(
          404,
          "Endpoint name must be one path segment of letters, numbers, dots, dashes, or underscores.",
        );
      const receivedAt = new Date().toISOString();
      const body = await readBody(request, config.maxBodyBytes);
      const query = [...url.searchParams.entries()];
      const capture = {
        id: randomUUID(),
        endpoint,
        receivedAt,
        method,
        path: pathname,
        rawQuery: url.search.slice(1),
        query,
        headers: rawHeadersForStorage(
          request,
          config.additionalRedactedHeaders,
        ),
        contentType: request.headers["content-type"] || "",
        body,
      };
      try {
        store.insert(capture);
      } catch (error) {
        logger.error?.(
          `[HookScope] capture storage failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
        throw new HttpError(
          507,
          "Capture could not be stored. Check the data directory and configured database limit.",
        );
      }
      return sendJson(response, 202, {
        id: capture.id,
        endpoint,
        receivedAt,
        bodySize: body.byteLength,
      });
    }

    const staticFile = STATIC_FILES.get(pathname);
    if (staticFile && method === "GET")
      return serveStatic(response, ...staticFile);
    throw new HttpError(404, "Route not found.");
  }

  const server = createHttpServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const statusCode = Number.isInteger(error.statusCode)
        ? error.statusCode
        : 500;
      if (statusCode >= 500 && !(error instanceof HttpError))
        logger.error?.(
          `[HookScope] request failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      sendJson(response, statusCode, {
        error: statusCode === 500 ? "Internal server error." : error.message,
      });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 1000;

  return {
    server,
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          try {
            store.close();
          } catch (closeError) {
            reject(closeError);
            return;
          }
          if (error) reject(error);
          else resolve();
        });
      });
    },
    address: () => server.address(),
  };
}

async function main() {
  const config = loadConfig();
  const app = createHookScope({ config });
  app.server.listen(config.port, config.host, () => {
    process.stdout.write(
      `HookScope listening at http://${config.host}:${config.port}\n`,
    );
    process.stdout.write(
      `Capture storage: ${path.join(config.dataDir, "hookscope.sqlite")}\n`,
    );
    if (config.replayTargets.length === 0)
      process.stdout.write(
        "Replay is disabled; configure HOOKSCOPE_REPLAY_TARGETS to enable it.\n",
      );
  });
  const stop = () => app.close().finally(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(
      `HookScope could not start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
