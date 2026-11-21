const extensionOrigin = /^(?:chrome-extension|moz-extension|safari-web-extension):\/\/[a-z0-9.-]+$/i;
const corsMethods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

function configuredOrigin(value) {
  // Accept an HTTPS origin with an optional trailing slash, including a port.
  const input = String(value).trim();
  if (!/^https:\/\/[^/?#@*\\\s]+\/?$/i.test(input)) return null;
  try {
    return new URL(input).origin;
  } catch {
    return null;
  }
}

function denied(status, message) {
  return new Response(message, { status, headers: { "Cache-Control": "no-store", Vary: "Origin" } });
}

export async function withAllowedOrigin(request, setting, forward) {
  if (setting === undefined) return forward();
  const allowed = configuredOrigin(setting);
  if (!allowed) return denied(500, "ALLOWED_ORIGIN must be a single HTTPS origin.");

  const origin = request.headers.get("Origin");
  // Installed clients with their own origin keep Bitwarden's upstream policy.
  if (origin === "bw-desktop-file://bundle" || origin === "file://" || extensionOrigin.test(origin)) {
    return forward();
  }
  if (origin !== null && origin !== allowed) return denied(403, "Origin is not allowed.");

  const method = request.headers.get("Access-Control-Request-Method");
  if (request.method === "OPTIONS" && method !== null) {
    if (!origin || !corsMethods.has(method)) return denied(403, "Preflight is not allowed.");
    const headers = new Headers({
      "Access-Control-Allow-Origin": allowed,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": method,
      "Cache-Control": "no-store",
      Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    });
    const requestedHeaders = request.headers.get("Access-Control-Request-Headers");
    if (requestedHeaders) headers.set("Access-Control-Allow-Headers", requestedHeaders);
    return new Response(null, { status: 204, headers });
  }

  const response = await forward();
  if (response.status === 101) return response;
  // The proxy constructs mutable HTTP responses. Preserve existing Vary fields.
  const headers = response.headers;
  if (origin === allowed) {
    headers.set("Access-Control-Allow-Origin", allowed);
    headers.set("Access-Control-Allow-Credentials", "true");
  } else {
    headers.delete("Access-Control-Allow-Origin");
    headers.delete("Access-Control-Allow-Credentials");
  }
  const vary = (headers.get("Vary") ?? "").toLowerCase().split(",").map((name) => name.trim());
  if (!vary.includes("*") && !vary.includes("origin")) headers.append("Vary", "Origin");
  return response;
}
