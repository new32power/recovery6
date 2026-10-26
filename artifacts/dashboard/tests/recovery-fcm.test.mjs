import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";
import test from "node:test";

const source = await readFile(new URL("../functions/_worker.ts", import.meta.url), "utf8");
const jwtCode = source.slice(source.indexOf("async function signJwt"), source.indexOf("async function requireJwt"));
const handlers = source.slice(source.indexOf("// ------- RECOVERY AND FCM DIAGNOSTICS"), source.indexOf('app.post("/api/fcm/online-check"'));
const js = (await transform(jwtCode + "\n" + handlers, { loader: "ts", target: "es2022" })).code;

// No real database, device registration token, Firebase credential or network.
function harness({ active = true, configured = true, rejected = {}, dbError = false, deviceApp = "SYNTHETIC-APP" } = {}) {
  const queries = [], sends = [], routes = new Map();
  const targets = [1, 2, 3].map(id => ({ device_id: `synthetic-device-${id}`, fcm_token: `synthetic-token-${id}` }));
  const sqlC = async (query, values) => {
    queries.push({ query, values });
    assert.match(query, /^SELECT /);
    if (dbError) throw new Error("synthetic DB failure");
    if (query.includes("sessions")) return active ? [{ id: "synthetic-session" }] : [];
    assert.equal(values[0], "SYNTHETIC-APP"); // Every device query must be scoped.
    if (query.includes("COUNT(*)")) return [{ total: targets.length }];
    return targets.slice(values[2], values[2] + values[1]);
  };
  const send = async (_env, token, data) => {
    sends.push({ token, data });
    if (rejected[token]) throw rejected[token];
    return { messageId: "synthetic-firebase-message-id" };
  };
  const api = new Function("neon", "app", "getFirebaseCredentials", "sendFcmToToken", "getDb", "devices", "eq",
    js + "\nreturn {signJwt, describeFcmFailure};")(
    () => sqlC,
    { post: (path, handler) => routes.set(path, handler) },
    () => { if (!configured) throw new Error("synthetic config failure"); return {}; },
    send,
    () => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [{
      deviceId: "synthetic-device", appId: deviceApp, fcmToken: "synthetic-token-1",
    }] }) }) }) }),
    {}, () => ({}),
  );
  const token = async (extra = {}) => api.signJwt({
    sub: "synthetic-session", appId: "SYNTHETIC-APP", role: "sub-admin", iss: "mr-panel",
    exp: Math.floor(Date.now() / 1000) + 600, ...extra,
  }, "synthetic-jwt-secret");
  const invoke = (body, authorization = "", path = "/api/recovery", jwt = "synthetic-jwt-secret", origin = "https://recovery2-robot.pages.dev") => routes.get(path)({
    env: { JWT_SECRET: jwt, NEON_DATABASE_URL: "not-a-real-database" },
    req: { url: new URL(path, origin).toString(), header: () => authorization, json: async () => body },
    json: (body, status = 200) => ({ status, body }),
  });
  return { ...api, token, invoke, queries, sends };
}
const providerError = (status, code, extra = []) => ({
  fcmStatus: status, fcmBody: { error: { status: code, details: [...extra, { errorCode: code }] } },
});

test("recovery requires signed, unexpired sub-admin authentication", async () => {
  const h = harness();
  assert.equal((await h.invoke({})).status, 401);
  assert.equal(h.queries.length, 0);
  assert.equal((await h.invoke({}, "Bearer invalid")).status, 401);
  assert.equal((await h.invoke({}, "Bearer " + await h.token({ exp: 1 }))).status, 401);
  assert.equal((await h.invoke({}, "Bearer " + await h.token({ role: "master" }))).status, 401);
  assert.equal(h.sends.length, 0);
});
test("revoked session cannot send recovery commands", async () => {
  const h = harness({ active: false });
  assert.equal((await h.invoke({}, "Bearer " + await h.token())).status, 401);
  assert.equal(h.sends.length, 0);
});
test("recovery cannot select a different app from request data", async () => {
  const h = harness();
  const result = await h.invoke({ appId: "ANOTHER-APP" }, "Bearer " + await h.token());
  assert.equal(result.status, 403);
  assert.equal(h.queries.length, 1); // Session check only.
  assert.equal(h.sends.length, 0);
});
test("batch pagination is bounded and rejects invalid values", async () => {
  for (const body of [{ offset: -1 }, { offset: "0" }, { limit: 100 }, { limit: 0 }, { limit: 1.2 }, null, []]) {
    const h = harness();
    assert.equal((await h.invoke(body, "Bearer " + await h.token())).status, 400);
    assert.equal(h.sends.length, 0);
  }
});
test("recovery sends this deployment's API URL and never edits SQL data", async () => {
  const h = harness();
  const result = await h.invoke({ offset: 0, limit: 2 }, "Bearer " + await h.token());
  assert.equal(result.status, 200);
  assert.deepEqual({ ok: result.body.ok, fail: result.body.fail, processed: result.body.processed, done: result.body.done },
    { ok: 2, fail: 0, processed: 2, done: false });
  assert.equal(result.body.url, "https://recovery2-robot.pages.dev/api");
  assert.equal(result.body.deliveryConfirmed, false);
  assert.ok(h.sends.every(s => s.data.type === "url_update" && s.data.url === result.body.url));
  assert.doesNotMatch(JSON.stringify(result), /synthetic-token/);
});
test("recovery URL follows the active Pages deployment", async () => {
  for (const [origin, expected] of [
    ["https://recovery2-robot.pages.dev", "https://recovery2-robot.pages.dev/api"],
    ["https://recovery5-7f2.pages.dev", "https://recovery5-7f2.pages.dev/api"],
  ]) {
    const h = harness();
    const result = await h.invoke({}, "Bearer " + await h.token(), "/api/recovery", undefined, origin);
    assert.equal(result.status, 200);
    assert.equal(result.body.url, expected);
    assert.ok(h.sends.every(s => s.data.url === expected));
  }
});
test("provider-rejected registrations are counted as failures, not recovered devices", async () => {
  const h = harness({ rejected: { "synthetic-token-2": providerError(404, "UNREGISTERED") } });
  const result = await h.invoke({}, "Bearer " + await h.token());
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, 2);
  assert.equal(result.body.fail, 1);
  assert.equal(result.body.errors[0].code, "UNREGISTERED");
  assert.equal(result.body.errors[0].count, 1);
});
test("pagination beyond targets finishes without sending messages", async () => {
  const h = harness();
  const result = await h.invoke({ offset: 100 }, "Bearer " + await h.token());
  assert.equal(result.body.done, true);
  assert.equal(result.body.ok, 0);
  assert.equal(h.sends.length, 0);
});
test("missing Firebase config or DB failure is a visible failure, not false success", async () => {
  for (const options of [{ configured: false }, { dbError: true }]) {
    const h = harness(options);
    const result = await h.invoke({}, "Bearer " + await h.token());
    assert.equal(result.status, 503);
    assert.equal(result.body.ok, undefined);
    assert.equal(h.sends.length, 0);
  }
});
test("FCM 404 is not automatically mislabeled as an expired token", () => {
  const h = harness();
  assert.equal(h.describeFcmFailure(providerError(404, "NOT_FOUND")).status, 502);
  assert.equal(h.describeFcmFailure(providerError(404, "UNREGISTERED", [{}])).status, 410);
  assert.equal(h.describeFcmFailure(providerError(403, "SENDER_ID_MISMATCH")).code, "SENDER_ID_MISMATCH");
});
test("FCM commands require admin auth and sub-admin app ownership", async () => {
  const body = { deviceId: "synthetic-device", data: { type: "0" } };
  const anonymous = harness();
  assert.equal((await anonymous.invoke(body, "", "/api/fcm/send")).status, 401);
  assert.equal(anonymous.sends.length, 0);
  const other = harness({ deviceApp: "ANOTHER-APP" });
  assert.equal((await other.invoke(body, "Bearer " + await other.token(), "/api/fcm/send")).status, 403);
  assert.equal(other.sends.length, 0);
  const master = harness();
  assert.equal((await master.invoke(body, "Bearer " + await master.token({ role: "master" }), "/api/fcm/send")).status, 200);
});
test("FCM route returns provider error codes without exposing registration tokens", async () => {
  const h = harness({ rejected: { "synthetic-token-1": providerError(404, "UNREGISTERED") } });
  const result = await h.invoke({ deviceId: "synthetic-device", data: { type: "0" } },
    "Bearer " + await h.token(), "/api/fcm/send");
  assert.equal(result.status, 410);
  assert.equal(result.body.code, "UNREGISTERED");
  assert.doesNotMatch(JSON.stringify(result), /synthetic-token/);
});
test("frontend recovery shows request failures and the correct API target", async () => {
  const frontend = await readFile(new URL("../src/pages/WebDashboard.tsx", import.meta.url), "utf8");
  const recovery = frontend.slice(frontend.indexOf("/* ── Send Backend URL"), frontend.indexOf("/* ── Licence Countdown"));
  assert.ok(recovery.includes('const BACKEND_URL = `${window.location.origin}/api`;'));
  assert.doesNotMatch(recovery, /https:\/\/recovery5-7f2\.pages\.dev\/api/);
  assert.doesNotMatch(recovery, /mr-recovery-api-502z|if \(!r\.ok\) break|catch \{ \/\* ignore \*\/ \}|devices recovered|✅ Recovery Complete/);
  assert.match(recovery, /setSendUrlState\("err"\)/);
  assert.match(recovery, /role="alert"/);
  assert.match(recovery, /Device confirmation pending/);
});
