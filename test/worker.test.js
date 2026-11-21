import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";

const origin = "https://vault.example.test";
const env = { BITWARDEN_REGION: "US" };
const request = (path, init) => new Request(origin + path, init);

test("the root serves the bundled index internally and leaves missing assets to the asset handler", async () => {
  const assets = {
    async fetch(req) {
      return new URL(req.url).pathname === "/index.html"
        ? new Response("vault", { headers: { "Content-Type": "text/html" } })
        : new Response(null, { status: 404 });
    },
  };
  const bindings = { ...env, ASSETS: assets };
  const home = await worker.fetch(request("/?lang=zh"), bindings);
  assert.equal(home.status, 200);
  assert.equal(await home.text(), "vault");
  const index = await worker.fetch(request("/index.html?lang=zh"), bindings);
  assert.equal(index.status, 308);
  assert.equal(index.headers.get("location"), origin + "/?lang=zh");
  for (const path of ["/unknown.js", "/apiary/sync", "/https://example.org"]) {
    assert.equal((await worker.fetch(request(path), bindings)).status, 404);
  }
});

test("each prefix selects a fixed regional host and preserves the path and query", async (t) => {
  let upstream;
  t.mock.method(globalThis, "fetch", (req) => {
    upstream = new URL(req.url);
    return new Response(null, { status: 204 });
  });
  for (const [region, path, expected] of [
    ["US", "/api/sync?x=a%2Fb&x=c", "https://api.bitwarden.com/sync?x=a%2Fb&x=c"],
    ["EU", "/identity/connect/token", "https://identity.bitwarden.eu/connect/token"],
    ["US", "/notifications/hub/negotiate", "https://notifications.bitwarden.com/hub/negotiate"],
    ["US", "/icons/example.org/icon.png", "https://icons.bitwarden.net/example.org/icon.png"],
    ["EU", "/icons/example.org/icon.png", "https://icons.bitwarden.eu/example.org/icon.png"],
    ["EU", "/events/collect", "https://events.bitwarden.eu/collect"],
    ["US", "/scim/v2", "https://scim.bitwarden.com/v2"],
    ["US", "/api//elsewhere.example/a", "https://api.bitwarden.com//elsewhere.example/a"],
    ["US", "/api?test=1", "https://api.bitwarden.com/?test=1"],
  ]) {
    const res = await worker.fetch(request(path), { BITWARDEN_REGION: region });
    assert.equal(res.status, 204);
    assert.equal(upstream.href, expected);
  }
});

test("a vault request preserves its body and client headers without sending site cookies or proxy credentials", async (t) => {
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const upstream = new Request(input, init);
    assert.equal(upstream.redirect, "manual");
    assert.equal(upstream.cache, "no-store");
    assert.equal(upstream.method, "POST");
    assert.equal(await upstream.text(), "fixture");
    assert.equal(upstream.headers.get("authorization"), "Bearer fixture");
    assert.equal(upstream.headers.get("device-type"), "10");
    assert.equal(upstream.headers.get("origin"), origin);
    for (const name of ["cookie", "cf-access-jwt-assertion", "cf-access-client-secret", "x-forwarded-host", "host"]) {
      assert.equal(upstream.headers.get(name), null);
    }
    return new Response("upstream validation error", {
      status: 400,
      headers: { "set-cookie": "test=value", "cache-control": "public" },
    });
  });
  const res = await worker.fetch(request("/api/ciphers", {
    method: "POST", body: "fixture", headers: {
      authorization: "Bearer fixture", cookie: "local=value", "device-type": "10", origin,
      "cf-access-jwt-assertion": "fixture", "cf-access-client-secret": "fixture",
      "x-forwarded-host": "other.test", host: "other.test",
    },
  }), env);
  assert.equal(res.status, 400);
  assert.equal(await res.text(), "upstream validation error");
  assert.equal(res.headers.get("set-cookie"), null);
  assert.match(res.headers.get("cache-control"), /no-store/);
});

test("discovery advertises local service URLs and preserves official region, flags and external services", async (t) => {
  t.mock.method(globalThis, "fetch", () => Response.json({
    environment: {
      cloudRegion: "EU", api: "https://api.bitwarden.eu", vault: "https://vault.bitwarden.eu",
      identity: "https://identity.bitwarden.eu", notifications: "https://notifications.bitwarden.eu",
      sso: "https://sso.bitwarden.eu", fillAssistRules: "https://fillassist.bitwarden.com",
    },
    featureStates: { testFlag: true }, version: "fixture",
  }, { headers: { etag: '"upstream"', "content-length": "600" } }));
  const res = await worker.fetch(request("/api/config?client=mobile"), { BITWARDEN_REGION: "EU" });
  const config = await res.json();
  assert.deepEqual(config.environment, {
    cloudRegion: "EU", vault: origin, api: origin + "/api", identity: origin + "/identity",
    notifications: origin + "/notifications", sso: "https://sso.bitwarden.eu",
    fillAssistRules: "https://fillassist.bitwarden.com",
  });
  assert.deepEqual(config.featureStates, { testFlag: true });
  assert.equal(config.version, "fixture");
  assert.equal(res.headers.get("etag"), null);
  assert.equal(res.headers.get("content-length"), null);
});

test("redirects resolve against their upstream and external signed URLs stay intact", async (t) => {
  let location;
  t.mock.method(globalThis, "fetch", () => new Response(null, { status: 307, headers: { location } }));
  for (const [value, expected] of [
    ["../v2/page?q=1", origin + "/api/v2/page?q=1"],
    ["https://api.bitwarden.com/page", origin + "/api/page"],
    ["https://storage.example.test/file?sig=a%2Fb", "https://storage.example.test/file?sig=a%2Fb"],
  ]) {
    location = value;
    const res = await worker.fetch(request("/api/v1/page"), env);
    assert.equal(res.status, 307);
    assert.equal(res.headers.get("location"), expected);
  }
});

test("the notifications upgrade returns the same WebSocket response", async (t) => {
  // Node's Response constructor does not implement workerd's 101 response extension.
  const switchingProtocols = { status: 101, webSocket: {} };
  t.mock.method(globalThis, "fetch", (req) => {
    assert.equal(req.headers.get("upgrade"), "websocket");
    assert.equal(req.url, "https://notifications.bitwarden.com/hub?id=fixture");
    return switchingProtocols;
  });
  assert.equal(await worker.fetch(request("/notifications/hub?id=fixture", {
    headers: { Upgrade: "websocket" },
  }), env), switchingProtocols);
});

test("an invalid region fails closed and a network error returns a generic gateway error", async (t) => {
  const network = t.mock.method(globalThis, "fetch", () => { throw new Error("private details"); });
  assert.equal((await worker.fetch(request("/api/config"), { BITWARDEN_REGION: "invalid" })).status, 500);
  assert.equal(network.mock.callCount(), 0);
  const res = await worker.fetch(request("/identity/connect/token"), env);
  assert.equal(res.status, 502);
  assert.doesNotMatch(await res.text(), /private details/);
});

test("premium pinning rewrites profile, sync and token responses only when enabled", async (t) => {
  const fixtures = () => ({
    "/accounts/profile": { Premium: false, Email: "user@example.test", Object: "profile" },
    "/sync": { profile: { Premium: false, Email: "user@example.test" }, folders: [], ciphers: [] },
    "/connect/token": { access_token: "fixture", Premium: false, ForcePasswordReset: false },
  });
  t.mock.method(globalThis, "fetch", (req) => {
    const fixture = fixtures()[new URL(req.url).pathname];
    return Response.json(fixture, { headers: { etag: '"upstream"', "content-length": "700" } });
  });
  const on = { ...env, BITWARDEN_FORCE_PREMIUM: "true" };
  const pinned = await worker.fetch(request("/api/accounts/profile"), on);
  const profile = await pinned.json();
  assert.equal(profile.Premium, true);
  assert.equal(profile.Email, "user@example.test");
  assert.equal(Object.keys(profile).some((name) => name === "premium"), false);
  assert.equal(pinned.headers.get("etag"), null);
  assert.equal(pinned.headers.get("content-length"), null);
  assert.match(pinned.headers.get("cache-control"), /no-store/);
  const sync = await (await worker.fetch(request("/api/sync", { method: "POST", body: "{}" }), on)).json();
  assert.equal(sync.profile.Premium, true);
  assert.deepEqual(sync.folders, []);
  const token = await (await worker.fetch(request("/identity/connect/token", { method: "POST" }), on)).json();
  assert.equal(token.Premium, true);
  assert.equal(token.access_token, "fixture");
  const off = await worker.fetch(request("/api/accounts/profile"), env);
  assert.equal((await off.json()).Premium, false);
  assert.equal(off.headers.get("etag"), '"upstream"');
});
