// Tests for the grs shim request handler (node:test, zero deps).
//
// Scope note: grs-path tests only cover behavior BEFORE the upstream Vercel
// handler import (404 / 400 / 429) — the vendored api/*.js lives only on the
// VPS, not in this repo. Streak-path tests run against a local mock upstream.
//
// Run: node --test infrastructure/grs/server/
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// --- mock upstream (must exist before server.mjs is imported: it reads
// STREAK_UPSTREAM_PORT / STREAK_UPSTREAM_TIMEOUT_MS at module load) ---------
const captured = { url: undefined, count: 0 };
let upstreamBehavior = () => ({ status: 200, headers: {}, body: "<svg>ok</svg>" });

const upstream = http.createServer((req, res) => {
  captured.url = req.url;
  captured.count += 1;
  const { status = 200, headers = {}, body = "<svg>ok</svg>", hold = false } = upstreamBehavior();
  if (hold) return; // never respond — exercises the shim's upstream timeout
  res.writeHead(status, headers);
  res.end(body);
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
process.env.STREAK_UPSTREAM_PORT = String(upstream.address().port);
process.env.STREAK_UPSTREAM_TIMEOUT_MS = "400";

const { handleRequest, __rateBuckets } = await import("./server.mjs");

test.after(() => upstream.close());

// --- mock req/res -----------------------------------------------------------
function makeReq({ host, url, method = "GET", headers = {} }) {
  return {
    url,
    method,
    headers: { host, ...headers },
    socket: { remoteAddress: "10.0.0.1" },
    on() {},
    pipe(dest) {
      dest.end(); // GET has no body; ending the upstream request triggers its flow
    },
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    headers: {},
    body: undefined,
    setHeader(k, v) {
      this.headers[String(k).toLowerCase()] = v;
    },
    writeHead(code, hdrs) {
      this.statusCode = code;
      this.headersSent = true;
      for (const [k, v] of Object.entries(hdrs || {})) {
        this.headers[String(k).toLowerCase()] = v;
      }
    },
    end(chunk) {
      this.writableEnded = true;
      if (chunk !== undefined) this.body = chunk;
    },
    destroy() {
      this.destroyed = true;
    },
  };
  return res;
}

function invoke(req) {
  return new Promise((resolve) => {
    const res = makeRes();
    const origEnd = res.end.bind(res);
    res.end = (chunk) => {
      origEnd(chunk);
      resolve(res);
    };
    handleRequest(req, res);
  });
}

function freshIp(tag) {
  // unique rate-limit key per test so buckets never cross-contaminate
  return { "cf-connecting-ip": `test-${tag}-${Math.random().toString(36).slice(2)}` };
}

const STREAK_HOST = { host: "streak.mangoqwq.com" };
const GRS_HOST = { host: "grs.mangoqwq.com" };

test("streak: cache-key param refused with 400 and never reaches upstream", async () => {
  const before = captured.count;
  const res = await invoke(makeReq({ ...STREAK_HOST, url: "/?user=dengyie&timezone=Asia/Tokyo", headers: freshIp("u1") }));
  assert.equal(res.statusCode, 400);
  assert.match(String(res.body), /unsupported parameter\(s\): timezone/);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(captured.count, before, "upstream must not be contacted");
});

test("streak: display params forwarded sorted, t= stripped", async () => {
  const before = captured.count;
  const res = await invoke(
    makeReq({ ...STREAK_HOST, url: "/?theme=tokyonight&t=1793728175&user=dengyie&hide_border=true", headers: freshIp("f1") }),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(captured.count, before + 1);
  assert.equal(captured.url, "/?hide_border=true&theme=tokyonight&user=dengyie", "sorted, no t");
  assert.equal(String(res.body), "<svg>ok</svg>");
});

test("streak: an unlisted display param still passes through (no allowlist to maintain)", async () => {
  const before = captured.count;
  const res = await invoke(
    makeReq({ ...STREAK_HOST, url: "/?user=dengyie&hide_week_days=true", headers: freshIp("f2") }),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(captured.count, before + 1);
  assert.match(captured.url, /hide_week_days=true/);
});

test("streak: hop-by-hop headers stripped, content-length restated", async () => {
  upstreamBehavior = () => ({
    status: 200,
    headers: { "connection": "keep-alive", "keep-alive": "timeout=5", "x-kept": "yes" },
    body: "<svg>hop</svg>",
  });
  const res = await invoke(makeReq({ ...STREAK_HOST, url: "/?user=dengyie", headers: freshIp("h1") }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["transfer-encoding"], undefined);
  assert.equal(res.headers["connection"], undefined);
  assert.equal(res.headers["keep-alive"], undefined);
  assert.equal(res.headers["x-kept"], "yes");
  assert.equal(res.headers["content-length"], String(Buffer.byteLength("<svg>hop</svg>")));
});

test("streak: HTTP-200 error card normalized to 503 + no-store, cache qualifiers stripped", async () => {
  upstreamBehavior = () => ({
    status: 200,
    headers: { "cache-control": "public, max-age=86400", "expires": "tomorrow", "last-modified": "yesterday" },
    body: "<!-- Error lable --> boom",
  });
  const res = await invoke(makeReq({ ...STREAK_HOST, url: "/?user=dengyie", headers: freshIp("e1") }));
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers.expires, undefined);
  assert.equal(res.headers["last-modified"], undefined);
});

test("streak: upstream 5xx normalized to 503", async () => {
  upstreamBehavior = () => ({ status: 500, headers: {}, body: "php exploded" });
  const res = await invoke(makeReq({ ...STREAK_HOST, url: "/?user=dengyie", headers: freshIp("e2") }));
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["cache-control"], "no-store");
});

test("streak: stalled upstream fails as clean 503 before CF 524", async () => {
  upstreamBehavior = () => ({ hold: true });
  const res = await invoke(makeReq({ ...STREAK_HOST, url: "/?user=dengyie", headers: freshIp("t1") }));
  assert.equal(res.statusCode, 503);
  assert.equal(String(res.body), "streak upstream unavailable");
});

test("streak: rate limit applies per client before proxying (429)", async () => {
  __rateBuckets.set("rl-streak", Array(60).fill(Date.now()));
  const res = await invoke(makeReq({ ...STREAK_HOST, url: "/?user=dengyie", headers: { "cf-connecting-ip": "rl-streak" } }));
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers["retry-after"], "60");
});

test("rate limit key is the Cloudflare client IP, not the socket peer", async () => {
  await invoke(makeReq({ ...GRS_HOST, url: "/index?username=dengyie", headers: { "cf-connecting-ip": "keyed-ip" } }));
  assert.ok(__rateBuckets.has("keyed-ip"), "bucket keyed on cf-connecting-ip");
  assert.equal(__rateBuckets.has("10.0.0.1"), false, "socket peer must not be the key when CF header present");
});

test("grs: unknown query param rejected with 400 (pre-existing gate intact)", async () => {
  const res = await invoke(makeReq({ ...GRS_HOST, url: "/index?username=dengyie&junk=1", headers: freshIp("g1") }));
  assert.equal(res.statusCode, 400);
  assert.match(String(res.body), /junk/);
});

test("grs: rate limit trips on the 61st request in the window", async () => {
  __rateBuckets.delete("rl-grs");
  let last;
  for (let i = 0; i < 61; i++) {
    last = await invoke(makeReq({ ...GRS_HOST, url: "/index?username=dengyie", headers: { "cf-connecting-ip": "rl-grs" } }));
  }
  assert.equal(last.statusCode, 429);
});

test("unknown host falls through to grs routing and 404s", async () => {
  const res = await invoke(makeReq({ host: "evil.example.com", url: "/", headers: freshIp("x1") }));
  assert.equal(res.statusCode, 404);
});
