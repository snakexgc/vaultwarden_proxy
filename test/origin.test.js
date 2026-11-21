import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";

const vault = "https://vault.example.test";
const proxy = "https://proxy.example.test";
const env = { BITWARDEN_REGION: "US", ALLOWED_ORIGIN: vault };
const request = (path, init) => new Request(proxy + path, init);

function headerTokens(response, header) {
  return (response.headers.get(header) ?? "").toLowerCase().split(",").map((token) => token.trim());
}

for (const [name, origin, path, init] of [
  ["a different hostname", "https://vault.example.test.other.test", "/api/ciphers", { method: "POST" }],
  ["a different port", "https://vault.example.test:8443", "/icons/example.test/icon.png", {}],
  ["an HTTP origin", "http://vault.example.test", "/events/collect", { method: "POST" }],
  ["an opaque origin", "null", "/identity/connect/token", { method: "POST" }],
  ["a foreign preflight", "https://other.test", "/scim/v2", {
    method: "OPTIONS", headers: { "Access-Control-Request-Method": "PUT" },
  }],
  ["a foreign WebSocket handshake", "https://other.test", "/notifications/hub", {
    headers: { Upgrade: "websocket" },
  }],
]) {
  test(`the proxy rejects ${name} before contacting Bitwarden`, async (t) => {
    const upstream = t.mock.method(globalThis, "fetch", () => new Response(null, { status: 204 }));
    const response = await worker.fetch(request(path, {
      ...init, headers: { ...init.headers, Origin: origin },
    }), env);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal(upstream.mock.callCount(), 0);
  });
}

test("the allowed browser origin can preflight its method and headers locally", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", () => new Response(null, { status: 405 }));
  const response = await worker.fetch(request("/api/ciphers", {
    method: "OPTIONS",
    headers: {
      Origin: vault, "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "Authorization, Content-Type, Device-Type",
    },
  }), env);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), vault);
  assert.ok(headerTokens(response, "vary").includes("origin"));
  assert.ok(headerTokens(response, "access-control-allow-methods").includes("put"));
  const headers = headerTokens(response, "access-control-allow-headers");
  for (const header of ["authorization", "content-type", "device-type"]) assert.ok(headers.includes(header));
  assert.equal(upstream.mock.callCount(), 0);
});

for (const status of [200, 401, 502]) {
  test(`the allowed origin can read a ${status} proxy response`, async (t) => {
    t.mock.method(globalThis, "fetch", () => {
      if (status === 502) throw new Error("upstream unavailable");
      return new Response("upstream body", {
        status, headers: { "Access-Control-Allow-Origin": "*", Vary: "Accept-Language" },
      });
    });
    const response = await worker.fetch(request("/api/ciphers", { headers: { Origin: vault } }), env);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("access-control-allow-origin"), vault);
    const vary = headerTokens(response, "vary");
    assert.ok(vary.includes("origin"));
    if (status !== 502) {
      assert.ok(vary.includes("accept-language"));
      assert.equal(await response.text(), "upstream body");
    }
  });
}

test("native clients reach the upstream without exposing its wildcard CORS policy", async (t) => {
  t.mock.method(globalThis, "fetch", () => new Response("vault data", {
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Credentials": "true" },
  }));
  const response = await worker.fetch(request("/api/ciphers"), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "vault data");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
  assert.ok(headerTokens(response, "vary").includes("origin"));
});

for (const clientOrigin of [
  "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
  "moz-extension://7e0b740c-0f64-4ddf-824c-54f1f0b58dba",
  "safari-web-extension://example.extension",
  "bw-desktop-file://bundle",
]) {
  test(`the upstream decides CORS for ${clientOrigin}`, async (t) => {
    const forwarded = [];
    t.mock.method(globalThis, "fetch", (input) => {
      forwarded.push([input.method, input.headers.get("origin")]);
      if (input.method === "OPTIONS") return new Response(null, { status: 403 });
      return new Response("client data", { headers: { "Access-Control-Allow-Origin": clientOrigin } });
    });
    const preflight = await worker.fetch(request("/api/ciphers", {
      method: "OPTIONS", headers: { Origin: clientOrigin, "Access-Control-Request-Method": "GET" },
    }), env);
    assert.equal(preflight.status, 403);
    assert.equal(preflight.headers.get("access-control-allow-origin"), null);
    const response = await worker.fetch(request("/api/ciphers", { headers: { Origin: clientOrigin } }), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), clientOrigin);
    assert.equal(response.headers.get("access-control-allow-credentials"), null);
    assert.deepEqual(forwarded, [["OPTIONS", clientOrigin], ["GET", clientOrigin]]);
  });
}

test("the allowed web vault keeps the notifications WebSocket upgrade", async (t) => {
  // Node cannot construct a 101 Response with the Workers WebSocket handle.
  const upgraded = { status: 101, webSocket: {} };
  const upstream = t.mock.method(globalThis, "fetch", () => upgraded);
  const response = await worker.fetch(request("/notifications/hub", {
    headers: { Origin: vault, Upgrade: "websocket" },
  }), env);
  assert.equal(response, upgraded);
  assert.equal(upstream.mock.callCount(), 1);
  assert.equal(upstream.mock.calls[0].arguments[0].headers.get("origin"), vault);
});

test("without an origin configured the proxy preserves the upstream CORS policy", async (t) => {
  const otherSite = "https://other.test";
  t.mock.method(globalThis, "fetch", () => new Response("upstream data", {
    headers: { "Access-Control-Allow-Origin": "*" },
  }));
  const response = await worker.fetch(request("/api/ciphers", {
    headers: { Origin: otherSite },
  }), { BITWARDEN_REGION: "EU" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(await response.text(), "upstream data");
});

test("an invalid configured origin fails closed, including for a request without Origin", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", () => new Response(null, { status: 204 }));
  for (const invalid of ["*", "vault.example.test", "http://vault.example.test", vault + "/path"]) {
    const response = await worker.fetch(request("/api/ciphers"), { ...env, ALLOWED_ORIGIN: invalid });
    assert.equal(response.status, 500, invalid);
    assert.equal(upstream.mock.callCount(), 0);
  }
});
