import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHookScope } from "../src/server.js";
import { loadConfig } from "../src/config.js";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function createApp(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hookscope-test-"));
  const env = { HOOKSCOPE_DATA_DIR: dataDir, ...overrides };
  const config = loadConfig(env);
  const app = createHookScope({ config, logger: { error() {} } });
  const port = await listen(app.server);
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { app, config, base: `http://127.0.0.1:${port}` };
}

async function json(response) {
  return response.json();
}

test("serves the dashboard and captures inspectable method, headers, query, and raw body", async (t) => {
  const { base } = await createApp(t);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Request inspector/);
  assert.equal(
    page.headers
      .get("content-security-policy")
      ?.includes("frame-ancestors 'none'"),
    true,
  );
  assert.equal(
    (await json(await fetch(`${base}/api/health`))).maxBodyBytes,
    262144,
  );

  const body = '{"event":"invoice.paid","amount":42}';
  const created = await fetch(
    `${base}/hooks/billing?tag=one&tag=two&source=cli`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer do-not-store-this",
        "x-api-token": "secret-token-value",
        "x-trace-id": "trace-42",
      },
      body,
    },
  );
  assert.equal(created.status, 202);
  const receipt = await json(created);
  assert.equal(receipt.bodySize, Buffer.byteLength(body));

  const detailResponse = await fetch(`${base}/api/captures/${receipt.id}`);
  assert.equal(detailResponse.status, 200);
  const { capture } = await json(detailResponse);
  assert.equal(capture.method, "PUT");
  assert.equal(capture.rawQuery, "tag=one&tag=two&source=cli");
  assert.deepEqual(capture.query, [
    ["tag", "one"],
    ["tag", "two"],
    ["source", "cli"],
  ]);
  assert.equal(capture.bodyText, body);
  assert.equal(
    capture.headers.find(
      (header) => header.name.toLowerCase() === "authorization",
    ).value,
    "[REDACTED]",
  );
  assert.equal(
    capture.headers.find(
      (header) => header.name.toLowerCase() === "x-api-token",
    ).value,
    "[REDACTED]",
  );
  assert.equal(
    capture.headers.find((header) => header.name.toLowerCase() === "x-trace-id")
      .value,
    "trace-42",
  );

  const filtered = await json(
    await fetch(`${base}/api/captures?q=tag&method=PUT&endpoint=billing`),
  );
  assert.equal(filtered.captures.length, 1);
  assert.equal(filtered.captures[0].id, receipt.id);
  const noMatch = await json(await fetch(`${base}/api/captures?method=GET`));
  assert.equal(noMatch.captures.length, 0);

  const deleted = await fetch(`${base}/api/captures/${receipt.id}`, {
    method: "DELETE",
  });
  assert.equal(deleted.status, 200);
  assert.equal((await fetch(`${base}/api/captures/${receipt.id}`)).status, 404);
});

test("replays only to configured loopback URLs, preserves the body, removes redacted headers, and stops redirects", async (t) => {
  let targetRequests = 0;
  let redirectFollowed = false;
  let received;
  const receiver = createServer(async (request, response) => {
    targetRequests += 1;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = {
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/should-not-follow" });
      response.end("no redirect follow");
      return;
    }
    if (request.url === "/should-not-follow") redirectFollowed = true;
    response.writeHead(201, {
      "content-type": "application/json",
      "set-cookie": "private=response-secret",
    });
    response.end('{"accepted":true}');
  });
  const receiverPort = await listen(receiver);
  t.after(() => new Promise((resolve) => receiver.close(() => resolve())));
  const targets = [
    {
      id: "sink",
      label: "Local sink",
      url: `http://127.0.0.1:${receiverPort}/sink`,
    },
    {
      id: "redirect",
      label: "Redirect test",
      url: `http://127.0.0.1:${receiverPort}/redirect`,
    },
  ];
  const { base } = await createApp(t, {
    HOOKSCOPE_REPLAY_TARGETS: JSON.stringify(targets),
  });
  const body = "payload for replay";
  const capture = await json(
    await fetch(`${base}/hooks/orders`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        authorization: "Bearer hidden",
        "x-custom": "keep-me",
      },
      body,
    }),
  );

  const replayResponse = await fetch(
    `${base}/api/captures/${capture.id}/replay`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetId: "sink" }),
    },
  );
  assert.equal(replayResponse.status, 200);
  const replayed = (await json(replayResponse)).replay;
  assert.equal(replayed.status, 201);
  assert.equal(replayed.preview, '{"accepted":true}');
  assert.equal(
    replayed.headers.find((header) => header.name === "set-cookie").value,
    "[REDACTED]",
  );
  assert.equal(received.url, "/sink");
  assert.equal(received.body, body);
  assert.equal(received.headers["x-custom"], "keep-me");
  assert.equal(received.headers.authorization, undefined);

  const redirectResponse = await fetch(
    `${base}/api/captures/${capture.id}/replay`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetId: "redirect" }),
    },
  );
  assert.equal(redirectResponse.status, 200);
  assert.equal((await json(redirectResponse)).replay.redirected, true);
  assert.equal(redirectFollowed, false);
  assert.equal(targetRequests, 2);

  const unlisted = await fetch(`${base}/api/captures/${capture.id}/replay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetId: "http://example.com" }),
  });
  assert.equal(unlisted.status, 400);
});

test("rejects oversized bodies, enforces retention, and rejects remote replay configuration", async (t) => {
  const { base } = await createApp(t, {
    HOOKSCOPE_MAX_BODY_BYTES: "1024",
    HOOKSCOPE_MAX_CAPTURES: "2",
  });
  const oversized = await fetch(`${base}/hooks/large`, {
    method: "POST",
    body: "x".repeat(1025),
  });
  assert.equal(oversized.status, 413);
  assert.equal(
    (await json(await fetch(`${base}/api/captures`))).captures.length,
    0,
  );

  const first = await json(
    await fetch(`${base}/hooks/retained`, { method: "POST", body: "first" }),
  );
  const second = await json(
    await fetch(`${base}/hooks/retained`, { method: "POST", body: "second" }),
  );
  const third = await json(
    await fetch(`${base}/hooks/retained`, { method: "POST", body: "third" }),
  );
  const rows = (await json(await fetch(`${base}/api/captures?limit=100`)))
    .captures;
  assert.equal(rows.length, 2);
  assert.equal(
    rows.some((row) => row.id === first.id),
    false,
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    [third.id, second.id],
  );

  assert.throws(
    () =>
      loadConfig({
        HOOKSCOPE_REPLAY_TARGETS:
          '[{"id":"remote","label":"Remote","url":"https://example.com/hook"}]',
      }),
    /literal loopback IP/,
  );
  assert.throws(
    () =>
      loadConfig({
        HOOKSCOPE_REPLAY_TARGETS:
          '[{"id":"dns","label":"DNS","url":"http://localhost:3000/hook"}]',
      }),
    /literal loopback IP/,
  );
});

test("rejects external listeners, foreign browser origins, and DNS Host lookalikes", async (t) => {
  assert.throws(() => loadConfig({ HOOKSCOPE_HOST: "0.0.0.0" }), /loopback/i);
  const { base } = await createApp(t);
  assert.equal(
    (
      await fetch(`${base}/api/health`, {
        headers: { Origin: "https://example.com" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${base}/api/health`, {
        headers: { "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
    403,
  );
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const req = request(
      `${base}/api/health`,
      { headers: { Host: "127.0.0.1.example.com" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal(
    (await fetch(`${base}/api/health`, { headers: { Origin: base } })).status,
    200,
  );
});
