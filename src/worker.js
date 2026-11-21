import { withAllowedOrigin } from "./origin-policy.js";

const regions = new Map([
  ["US", "bitwarden.com"],
  ["EU", "bitwarden.eu"],
]);
const services = new Set(["api", "identity", "notifications", "events", "icons", "scim"]);

// Response paths whose "Premium" field pins the web vault's membership state.
const premiumPaths = new Map([
  ["api", new Set(["/accounts/profile", "/sync"])],
  ["identity", new Set(["/connect/token"])],
]);

function pinPremium(data, service, pathname) {
  // Sync responses nest the profile one level below the root.
  const root = service === "api" && pathname === "/sync" ? data?.profile : data;
  if (!root || typeof root !== "object") return false;
  // The API answers with PascalCase properties; match them without assuming case.
  const key = Object.keys(root).find((name) => name.toLowerCase() === "premium");
  if (key) root[key] = true;
  else root.Premium = true;
  return true;
}

function proxyError(status, message) {
  return new Response(message, { status, headers: { "Cache-Control": "no-store" } });
}

async function readRegistrationSetting(domain) {
  try {
    // Fetch only the public, region-wide settings. No browser headers or query are needed.
    const response = await fetch("https://api." + domain + "/config", {
      headers: { Accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(3000),
    });
    if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
      const config = await response.json();
      const disabled = config?.settings?.disableUserRegistration;
      if (typeof disabled === "boolean") return disabled;
    }
  } catch {
    // A timeout or invalid public configuration must not prevent the login form from rendering.
  }
  return null;
}

async function vaultStyles(url, method, env) {
  const domain = regions.get(env.BITWARDEN_REGION);
  if (!domain) return proxyError(500, "BITWARDEN_REGION must be US or EU.");
  const [base, registrationDisabled] = await Promise.all([
    env.ASSETS.fetch(new Request(url.origin + url.pathname, { method })),
    readRegistrationSetting(domain),
  ]);
  if (!base.ok) return base;
  const headers = {
    "Content-Type": "text/css; charset=utf-8",
    "Cache-Control": registrationDisabled === null ? "no-store" : "public, max-age=300",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  if (method === "HEAD") return new Response(null, { headers });
  if (registrationDisabled === true) {
    const css = await base.text();
    return new Response(css + "\n.vw-signup-link { display: none !important; }\n", { headers });
  }
  return new Response(base.body, { headers });
}

function makeUpstreamRequest(request, target, service, discovery) {
  const upstream = new Request(target, request);
  const headers = upstream.headers;
  // These belong to the custom domain or the proxy hop, not to a Bitwarden client.
  for (const name of ["host", "cookie", "forwarded", "x-real-ip", "proxy-authorization", "referer"]) {
    headers.delete(name);
  }
  for (const name of [...headers.keys()]) {
    if (name.startsWith("cf-") || name.startsWith("x-forwarded-")) headers.delete(name);
  }
  if (service === "icons") headers.delete("authorization");
  if (discovery) {
    // The locally advertised document has a different representation and validators.
    for (const name of ["if-none-match", "if-modified-since", "range", "if-range"]) headers.delete(name);
  }
  return upstream;
}

async function proxy(request, url, service, domain, pinMembership) {
  const host = service === "icons" && domain === "bitwarden.com" ? "icons.bitwarden.net" : service + "." + domain;
  // Set pathname separately: a suffix starting with "//" must never select a new host.
  const target = new URL("https://" + host);
  target.pathname = url.pathname.slice(service.length + 1) || "/";
  target.search = url.search;

  const discovery = service === "api" && /^\/config\/?$/i.test(target.pathname) &&
    (request.method === "GET" || request.method === "HEAD");
  const upstream = makeUpstreamRequest(request, target, service, discovery);
  try {
    const response = await fetch(upstream, { redirect: "manual", cache: "no-store" });
    if (response.status === 101) return response;

    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.delete("set-cookie");
    if (service === "icons") {
      headers.set("Content-Security-Policy", "sandbox; default-src 'none'");
      headers.set("X-Content-Type-Options", "nosniff");
    }

    if (response.status >= 300 && response.status < 400 && headers.has("location")) {
      const redirect = new URL(headers.get("location"), target);
      const location = redirect.origin === target.origin
        ? url.origin + "/" + service + redirect.pathname + redirect.search + redirect.hash
        : redirect.href;
      headers.set("location", location);
    }

    if (pinMembership && response.status === 200 &&
      premiumPaths.get(service)?.has(target.pathname) &&
      headers.get("content-type")?.includes("application/json")) {
      const data = await response.json();
      if (pinPremium(data, service, target.pathname)) {
        // The body changed, so upstream validators and lengths no longer apply.
        for (const name of ["content-length", "content-encoding", "etag", "last-modified"]) headers.delete(name);
        return new Response(JSON.stringify(data), {
          status: response.status, statusText: response.statusText, headers,
        });
      }
    }

    if (discovery && response.status === 200 && headers.get("content-type")?.includes("application/json")) {
      for (const name of ["content-length", "content-encoding", "etag", "last-modified", "accept-ranges", "content-md5", "digest"]) {
        headers.delete(name);
      }
      if (request.method === "GET") {
        const config = await response.json();
        Object.assign(config.environment, {
          vault: url.origin, api: url.origin + "/api", identity: url.origin + "/identity",
          notifications: url.origin + "/notifications",
        });
        return Response.json(config, { headers });
      }
    }

    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch {
    return proxyError(502, "Bitwarden upstream unavailable.");
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const service = url.pathname.split("/", 2)[1];
    if (services.has(service)) {
      return withAllowedOrigin(request, env.ALLOWED_ORIGIN, () => {
        const domain = regions.get(env.BITWARDEN_REGION);
        if (!domain) return proxyError(500, "BITWARDEN_REGION must be US or EU.");
        const pinMembership = String(env.BITWARDEN_FORCE_PREMIUM).toLowerCase() === "true";
        return proxy(request, url, service, domain, pinMembership);
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    if (url.pathname === "/css/vaultwarden.css") {
      return vaultStyles(url, request.method, env);
    }
    if (url.pathname === "/index.html") {
      url.pathname = "/";
      return Response.redirect(url, 308);
    }
    if (url.pathname === "/") {
      url.pathname = "/index.html";
      return env.ASSETS.fetch(new Request(url, request));
    }
    return env.ASSETS.fetch(request);
  },
};
