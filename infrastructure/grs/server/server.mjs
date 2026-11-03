// github-readme-stats self-hosted shim (canonical source: dengyie/dengyie infrastructure/grs/)
//
// Wraps upstream Vercel serverless handlers (api/*.js, `export default async (req,res)`)
// as a plain HTTP(S) server. Deployed to huawei-sg:/opt/github-readme-stats/server/server.mjs.
//
// Behaviour:
// - req: adds .query / .cookies ; res: adds .status()/.send()/.json() (Vercel enhanced API)
// - Route allowlist: index/pin/top-langs only (gist needs a PAT_2 pool, wakatime unused).
// - Param allowlist: unknown query params -> 400 BEFORE any upstream/API call, so junk
//   requests can neither pollute the cache nor burn the GitHub token quota.
// - `t` param: reserved cache-bust for the daily workflow fetch (bypasses shim cache AND
//   the Cloudflare edge cache, whose key includes the full query string).
// - Error cards: upstream renders failures as SVG with HTTP 200; detected and re-sent
//   as 503 so consumers (update-stats.yml) fail loudly instead of committing broken cards.
// - Caching: in-memory 10min for good responses (skipped for bust requests); rate limit
//   60 req/min/IP with opportunistic per-bucket expiry GC.
// - Host routing: Host streak.mangoqwq.com is transparently proxied to the local
//   github-readme-streak-stats PHP app (loopback :8080), bypassing grs logic; its
//   HTTP-200 error SVGs are normalized to 503 + no-store (see handler).
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 80);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 0);
const HOST = process.env.HOST || "0.0.0.0";
const TOKEN_PATH = process.env.GITHUB_TOKEN_FILE || "/etc/grs/github_token";

// Host-based virtual hosting: streak.mangoqwq.com (github-readme-streak-stats,
// PHP built-in server on loopback :8080) rides the same 80/443 listeners as grs.
// Streak traffic is transparently proxied and BYPASSES all grs-specific logic
// below (route allowlist, param allowlist, rate limit, in-memory cache) — the
// PHP app has its own 24h cache and error-card rendering.
const STREAK_HOSTS = new Set([
  "streak.mangoqwq.com",
  "streak.mangoqwq.com:80",
  "streak.mangoqwq.com:443",
]);
const STREAK_UPSTREAM_HOST = process.env.STREAK_UPSTREAM_HOST || "127.0.0.1";
const STREAK_UPSTREAM_PORT = Number(process.env.STREAK_UPSTREAM_PORT || 8080);
// Hop-by-hop headers per RFC 9110 §7.6.1 — stripped when proxying streak traffic.
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

const KNOWN = new Set(["index", "pin", "top-langs"]);
// Union of query params accepted by the three upstream cards (api/index.js, pin.js,
// top-langs.js) + our reserved `t` cache-bust. New card params must be added here.
const PARAM_ALLOWLIST = new Set([
  "username", "hide", "hide_title", "hide_border", "card_width", "hide_rank",
  "show_icons", "include_all_commits", "commits_year", "line_height",
  "title_color", "ring_color", "icon_color", "text_color", "text_bold",
  "bg_color", "theme", "cache_seconds", "exclude_repo", "custom_title",
  "locale", "disable_animations", "border_radius", "number_format",
  "number_precision", "border_color", "rank_icon", "show",
  "repo", "show_owner", "description_lines_count",
  "layout", "langs_count", "size_weight", "count_weight", "hide_progress",
  "stats_format",
  "t",
]);
const MAX_SEARCH_LEN = 512;

// 10min, aligned with the CF edge TTL (override_origin 600s) and the streak
// PHP cache — one coherent freshness contract across all three layers.
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 64;
const RATE_MAX = 60;
const RATE_WINDOW_MS = 60 * 1000;

// Token comes from a 0640 root:grs file; PAT_1 is what the upstream retryer reads.
if (!process.env.GITHUB_TOKEN && !process.env.PAT_1) {
  try {
    const token = (await readFile(TOKEN_PATH, "utf8")).trim();
    if (token) process.env.PAT_1 = token;
  } catch {}
}

const handlers = new Map();
function getHandler(name) {
  if (!handlers.has(name)) {
    // Registered lazy import; name is allowlist-validated before use.
    handlers.set(name, import(path.join(ROOT, "api", `${name}.js`)).then((m) => m.default));
  }
  return handlers.get(name);
}

const cache = new Map(); // cacheKey -> {status, headers, body, at}
const hits = new Map();  // ip -> [timestamps]

function rateLimited(ip) {
  const now = Date.now();
  // Opportunistic GC: buckets are append-ordered, so an expired newest timestamp
  // means the whole bucket is expired. Never resets live buckets wholesale.
  if (hits.size > 2048) {
    for (const [k, arr] of hits) {
      if (arr[arr.length - 1] <= now - RATE_WINDOW_MS) hits.delete(k);
    }
  }
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_MAX;
}

const ERROR_MARK = "Something went wrong";

function noStore(res) {
  res.setHeader("Cache-Control", "no-store");
}

const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || "unknown";
  try {
    // streak.mangoqwq.com -> transparent proxy to the local PHP streak-stats app.
    // The PHP app renders failures as SVG with HTTP 200 (same trap as the grs
    // upstream error cards), so buffer and normalize them to 503 + no-store:
    // consumers (update-stats.yml) fail loudly and CF never caches a broken card.
    if (STREAK_HOSTS.has(String(req.headers.host || "").toLowerCase())) {
      const upstreamReq = http.request(
        {
          host: STREAK_UPSTREAM_HOST,
          port: STREAK_UPSTREAM_PORT,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: `${STREAK_UPSTREAM_HOST}:${STREAK_UPSTREAM_PORT}` },
        },
        (up) => {
          const chunks = [];
          up.on("data", (c) => chunks.push(c));
          up.on("end", () => {
            const body = Buffer.concat(chunks);
            const isError =
              up.statusCode !== 200 || body.includes("Error lable");
            // Hop-by-hop headers never cross a proxy boundary; content-length is
            // restated for the exact buffered body. Error responses additionally
            // lose every cache qualifier (the PHP app sets max-age=86400 BEFORE
            // its catch-path error rendering — an error card must never be
            // cached by CF, so 503 + no-store + no expires/last-modified).
            const headers = { ...up.headers };
            for (const h of HOP_BY_HOP) delete headers[h];
            headers["content-length"] = String(body.length);
            if (isError) {
              headers["cache-control"] = "no-store";
              delete headers.expires;
              delete headers["last-modified"];
            }
            res.writeHead(isError ? 503 : up.statusCode, headers);
            res.end(body);
          });
        },
      );
      // Fail loudly before CF's ~100s 524: a stalled PHP (e.g. GitHub GraphQL
      // hang) must become a clean 503 the workflow can retry/fallback on.
      upstreamReq.setTimeout(55_000, () =>
        upstreamReq.destroy(new Error("streak upstream timeout")),
      );
      upstreamReq.on("error", () => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.statusCode = 503;
        noStore(res);
        res.end("streak upstream unavailable");
      });
      req.on("aborted", () => upstreamReq.destroy());
      req.pipe(upstreamReq);
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const name = (url.pathname.split("/").filter(Boolean)[0] || "").replace(/\.js$/, "");
    if (!/^[a-z-]+$/.test(name) || !KNOWN.has(name)) {
      res.statusCode = 404;
      noStore(res);
      return res.end("Not Found");
    }
    if (rateLimited(ip)) {
      res.statusCode = 429;
      noStore(res);
      res.setHeader("Retry-After", "60");
      return res.end("Too Many Requests");
    }

    // Input validation gate: unknown params or oversized queries never reach the
    // upstream handler (and thus never the GitHub API or the cache).
    const search = url.searchParams;
    const unknown = [...search.keys()].filter((k) => !PARAM_ALLOWLIST.has(k));
    if (unknown.length > 0) {
      res.statusCode = 400;
      noStore(res);
      return res.end(`Bad Request: unknown parameter(s): ${unknown.join(", ")}`);
    }
    if (url.search.length > MAX_SEARCH_LEN) {
      res.statusCode = 400;
      noStore(res);
      return res.end("Bad Request: query too long");
    }

    // `t` = workflow cache-bust: bypass both cache layers, and don't cache the
    // unique response (a new key per day would slowly churn the LRU/FIFO window).
    const isBust = search.has("t");

    const cacheKey = name + "?" + [...search.entries()].sort().map(([k, v]) => `${k}=${v}`).join("&");
    if (!isBust) {
      const cached = cache.get(cacheKey);
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        res.writeHead(cached.status, cached.headers);
        return res.end(cached.body);
      }
    }

    Object.defineProperty(req, "query", { value: Object.fromEntries(search) });
    req.cookies = {};
    res.status = (code) => { res.statusCode = code; return res; };
    res.send = (body) => {
      if (!res.writableEnded) {
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""));
        if (buf.includes(ERROR_MARK)) {
          console.error(`error-card: ${name} ${url.search} ip=${ip}`);
          res.statusCode = 503;
          noStore(res);
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          origEnd("upstream error card");
          return res;
        }
        res.end(buf);
      }
      return res;
    };
    res.json = (obj) => {
      if (!res.headersSent) res.setHeader("Content-Type", "application/json");
      if (!res.writableEnded) res.end(JSON.stringify(obj));
      return res;
    };

    // capture upstream-set headers for the cache store
    const origSetHeader = res.setHeader.bind(res);
    const headers = {};
    res.setHeader = (k, v) => { headers[k.toLowerCase()] = v; return origSetHeader(k, v); };
    let sent = null;
    const origEnd = res.end.bind(res);
    res.end = function (chunk, ...rest) {
      if ((typeof chunk === "string" && chunk) || Buffer.isBuffer(chunk)) {
        sent = sent ? Buffer.concat([sent, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]) : Buffer.from(chunk);
      }
      return origEnd(chunk, ...rest);
    };

    const handler = await getHandler(name);
    await handler(req, res);

    if (sent && res.statusCode === 200 && !isBust) {
      cache.set(cacheKey, { body: sent, headers, status: 200, at: Date.now() });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
  } catch (err) {
    console.error("handler error:", err, `ip=${ip}`);
    if (!res.headersSent) res.statusCode = 500;
    noStore(res);
    if (!res.writableEnded) res.end("Internal Server Error");
  }
});

server.requestTimeout = 120_000;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 30_000;
server.connectionsCheckingInterval = 30_000;

server.listen(PORT, HOST, () => console.log(`grs http on ${HOST}:${PORT}`));

if (process.env.TLS_CERT && process.env.TLS_KEY && HTTPS_PORT) {
  try {
    const tls = { cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) };
    const httpsServer = https.createServer(tls, (req, res) => server.emit("request", req, res));
    httpsServer.requestTimeout = 120_000;
    httpsServer.headersTimeout = 65_000;
    httpsServer.keepAliveTimeout = 30_000;
    httpsServer.listen(HTTPS_PORT, HOST, () => console.log(`grs https on ${HOST}:${HTTPS_PORT}`));
  } catch (e) {
    console.error("https disabled:", e.message);
  }
}
