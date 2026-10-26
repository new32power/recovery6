import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import { build, transform } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const workerPath = resolve(here, "../functions/_worker.ts");
const frontendPath = resolve(here, "../src/pages/MainAdminPanel.tsx");
const source = await readFile(workerPath, "utf8");
const hashCode = source.slice(source.indexOf("const _PIN_PREFIX"), source.indexOf("// SECURITY:"));
const masterCode = source.slice(source.indexOf("let _masterPinCache:"), source.indexOf("// ------- MASTER ADMIN"));
const authCode = source.slice(source.indexOf("// In-memory rate limiter"), source.indexOf("/* ── GET /api/auth/config"));
const compiled = (await transform(hashCode + "\n" + masterCode + "\n" + authCode, { loader: "ts", target: "es2022" })).code;

// All SQL is intercepted. These tests never connect to a database or live site.
function harness({ stored = "synthetic-master-password", active = 0, jwt = "synthetic-jwt-secret", failInsert = false } = {}) {
  const queries = [];
  const routes = new Map();
  const sql = async (query, params) => {
    queries.push({ query, params });
    assert.doesNotMatch(query, /\b(DELETE|DROP|TRUNCATE|UPDATE)\b/i);
    if (query.includes("key = 'master_pin'")) return stored ? [{ value: stored }] : [];
    if (query.includes("key = 'master_session_limit'")) return [{ value: "3" }];
    if (query.includes("COUNT(*)")) return [{ c: active }];
    if (query.startsWith("INSERT INTO master_sessions") && failInsert) throw new Error("synthetic insert failure");
    return [];
  };
  const api = new Function("neon", "signJwt", "app", compiled + "\nreturn { hash: _hashPin };")(
    () => sql,
    async () => "synthetic.signed.token",
    { post: (path, handler) => routes.set(path, handler) },
  );
  const invoke = (password, malformed = false) => routes.get("/api/auth/password-verify")({
    env: { JWT_SECRET: jwt, PIN_PEPPER: "synthetic-pepper", NEON_DATABASE_URL: "not-a-real-db" },
    req: {
      header: () => "synthetic-test",
      json: async () => { if (malformed) throw new Error("invalid JSON"); return { password }; },
    },
    json: (body, status = 200) => ({ body, status }),
  });
  return { ...api, invoke, queries };
}

test("existing plaintext credential creates only a new session", async () => {
  const h = harness();
  const result = await h.invoke("synthetic-master-password");
  assert.equal(result.status, 200);
  assert.ok(result.body.token);
  assert.ok(result.body.sessionId);
  assert.equal(h.queries.filter(q => q.query.startsWith("INSERT INTO master_sessions")).length, 1);
});

test("existing PBKDF2 credential verifies without modifying its stored hash", async () => {
  const hash = await harness().hash("synthetic-master-password", "synthetic-pepper");
  const h = harness({ stored: hash });
  assert.equal((await h.invoke("synthetic-master-password")).status, 200);
});

test("incorrect password cannot create a session", async () => {
  const h = harness();
  assert.equal((await h.invoke("incorrect")).status, 401);
  assert.ok(h.queries.every(q => !q.query.startsWith("INSERT")));
});

test("empty or malformed input fails before database access", async () => {
  for (const [value, malformed] of [["", false], [undefined, false], [123, false], ["x", true], ["x".repeat(257), false]]) {
    const h = harness();
    assert.equal((await h.invoke(value, malformed)).status, 400);
    assert.equal(h.queries.length, 0);
  }
});

test("missing stored credential fails closed without a default", async () => {
  const h = harness({ stored: "" });
  assert.equal((await h.invoke("anything")).status, 503);
  assert.ok(h.queries.every(q => !q.query.startsWith("INSERT")));
});

test("session limit is enforced without deleting historical sessions", async () => {
  const h = harness({ active: 3 });
  assert.equal((await h.invoke("synthetic-master-password")).status, 429);
  assert.ok(h.queries.every(q => !q.query.startsWith("INSERT")));
});

test("missing JWT configuration cannot create a session", async () => {
  const h = harness({ jwt: "" });
  assert.equal((await h.invoke("synthetic-master-password")).status, 503);
  assert.ok(h.queries.every(q => !q.query.startsWith("INSERT")));
});

test("failed session insertion never returns a token", async () => {
  const h = harness({ failInsert: true });
  const result = await h.invoke("synthetic-master-password");
  assert.equal(result.status, 500);
  assert.equal(result.body.token, undefined);
});

test("repeated invalid attempts are rate limited", async () => {
  const h = harness();
  for (let i = 0; i < 5; i++) assert.equal((await h.invoke("incorrect")).status, 401);
  assert.equal((await h.invoke("incorrect")).status, 429);
});

test("complete Worker bundles and password form renders independently of Google", async () => {
  const temp = await mkdtemp(join(tmpdir(), "recovery2-auth-test-"));
  try {
    await build({
      entryPoints: [workerPath], bundle: true, format: "esm", platform: "neutral",
      conditions: ["worker", "browser"], external: ["cloudflare:*"], write: false, logLevel: "silent",
    });
    const outfile = join(temp, "render.cjs");
    await build({
      stdin: {
        contents: `import { MasterLogin } from ${JSON.stringify(frontendPath)};
          import { createElement } from "react";
          import { renderToStaticMarkup } from "react-dom/server";
          module.exports = renderToStaticMarkup(createElement(MasterLogin, {onAuth:()=>{}}));`,
        resolveDir: resolve(here, ".."),
      },
      bundle: true, platform: "node", format: "cjs", jsx: "automatic", outfile, logLevel: "silent",
    });
    const html = createRequire(import.meta.url)(outfile);
    assert.match(html, /type="password"/);
    assert.match(html, /Sign in with password/);
    assert.match(html, /current-password/);
    assert.doesNotMatch(html, /value="synthetic-master-password"/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
