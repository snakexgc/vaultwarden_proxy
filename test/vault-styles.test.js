import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import worker from "../src/worker.js";

const styleUrl = "https://vault.example.test/css/vaultwarden.css";
const baseCss = await readFile(new URL("../static/web-vault/css/vaultwarden.css", import.meta.url), "utf8");
const assets = { fetch: () => new Response(baseCss, { headers: { "Content-Type": "text/css" } }) };
const bindings = { ASSETS: assets, BITWARDEN_REGION: "US" };

function assertProxyStyles(css) {
  assert.ok(css.startsWith(baseCss));
  const rules = css.slice(baseCss.length).split("}").filter((rule) => /display:\s*none\s*!important/.test(rule));
  for (const selector of [
    ".vw-passkey-login", ".vw-or-text", "bit-unlock-via-prf", "app-webauthn-login-settings",
    ".vw-sso-login", "organization-options_button_link-sso-",
    ".providers-2fa-2", ".providers-2fa-6", ".providers-2fa-7",
    "app-two-factor-options bit-item:has(", "two-factor-auth-duo-clip",
    'svg[viewBox="3.33 3.33 76.49 75.83"]',
    "app-two-factor-auth app-two-factor-auth-webauthn",
    "form:has(app-two-factor-auth-duo, app-two-factor-auth-webauthn)",
  ]) {
    assert.ok(rules.some((rule) => rule.includes(selector)), `Missing hide rule for ${selector}`);
  }
}

test("CSS uses only the chosen region's anonymous public configuration", async (t) => {
  let publicRequest;
  let registrationDisabled = true;
  t.mock.method(globalThis, "fetch", (input, init) => {
    publicRequest = new Request(input, init);
    return Response.json({ settings: { disableUserRegistration: registrationDisabled } });
  });

  for (const [region, host] of [["EU", "api.bitwarden.eu"], ["US", "api.bitwarden.com"]]) {
    const request = new Request(styleUrl + "?private=value", { headers: {
      Cookie: "private=fixture", Authorization: "Bearer fixture", "If-None-Match": '"old-style"',
    } });
    const res = await worker.fetch(request, { ...bindings, BITWARDEN_REGION: region });
    const css = await res.text();
    assert.equal(publicRequest?.url, "https://" + host + "/config");
    assert.equal(publicRequest.method, "GET");
    assert.equal(publicRequest.redirect, "manual");
    for (const header of ["cookie", "authorization", "if-none-match"]) {
      assert.equal(publicRequest.headers.has(header), false);
    }
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/css/);
    assert.match(res.headers.get("cache-control"), /max-age=300/);
    assertProxyStyles(css);
    assert.equal(/\.vw-signup-link\s*\{\s*display:\s*none/.test(css), registrationDisabled);
    registrationDisabled = false;
  }
});

test("an unavailable or unrecognized config keeps the bundled login form usable", async (t) => {
  let reply;
  t.mock.method(globalThis, "fetch", () => reply());
  for (reply of [
    () => { throw new Error("offline"); },
    () => new Response(null, { status: 503 }),
    () => new Response("bad json", { headers: { "Content-Type": "application/json" } }),
    () => Response.json({ settings: { disableUserRegistration: "true" } }),
    () => Response.json({ featureStates: { "single-tap-passkey-authentication": false } }),
  ]) {
    const response = await worker.fetch(new Request(styleUrl), bindings);
    assert.equal(response.status, 200);
    const css = await response.text();
    assertProxyStyles(css);
    assert.ok(!css.includes(".vw-signup-link"));
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("HEAD returns stylesheet headers without a body and writes are rejected", async (t) => {
  const lookup = t.mock.method(globalThis, "fetch", () => Response.json({ settings: { disableUserRegistration: true } }));
  const head = await worker.fetch(new Request(styleUrl, { method: "HEAD" }), bindings);
  assert.equal(head.status, 200);
  assert.match(head.headers.get("content-type"), /^text\/css/);
  assert.equal(head.body, null);
  lookup.mock.resetCalls();
  const post = await worker.fetch(new Request(styleUrl, { method: "POST" }), bindings);
  assert.equal(post.status, 405);
  assert.equal(lookup.mock.callCount(), 0);
});
