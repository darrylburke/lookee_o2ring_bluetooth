// Request guards for a server that has no login and normally listens on localhost.
//
// 1. Host allow-list - stops DNS rebinding: a hostile web page cannot point its own domain at 127.0.0.1 and then
//    read your data "same-origin", because the Host header would be that domain.
// 2. For anything that changes data: the body must be JSON (browsers cannot send that cross-site without a CORS
//    preflight, which this server never approves) and, when the browser sends an Origin, it must be this server.

const hostname = value => {                      // "example.com:3000" / "[::1]:3000" / "http://host:port" -> bare host
  try { return new URL(/^[a-z]+:\/\//i.test(value) ? value : `http://${value}`).hostname.replace(/^\[|\]$/g, "").toLowerCase(); }
  catch { return null; }
};

export function allowedHosts(env = process.env) {
  const hosts = new Set(["localhost", "127.0.0.1", "::1"]);
  const listen = (env.HOST || "").trim().toLowerCase();
  if (listen && !["0.0.0.0", "::"].includes(listen)) hosts.add(listen.replace(/^\[|\]$/g, ""));
  for (const h of (env.O2RING_ALLOWED_HOSTS || "").split(",")) if (h.trim()) hosts.add(h.trim().toLowerCase());
  return hosts;
}

/** Returns null when the request may proceed, or {status, error}. */
export function checkRequest({ method, host, origin, contentType }, hosts) {
  const name = host ? hostname(host) : null;
  if (!name || !hosts.has(name))
    return { status: 403, error: `host "${host || ""}" is not allowed - add it to O2RING_ALLOWED_HOSTS to reach the server under that name` };
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return null;
  if (!/^application\/json\b/i.test(contentType || "")) return { status: 415, error: "send JSON (Content-Type: application/json)" };
  if (origin && hostname(origin) !== name) return { status: 403, error: "cross-site request refused" };
  return null;
}

export const guard = hosts => (req, res, next) => {
  const verdict = checkRequest({ method: req.method, host: req.headers.host, origin: req.headers.origin, contentType: req.headers["content-type"] }, hosts);
  if (verdict) return res.status(verdict.status).json({ error: verdict.error });
  next();
};
