import { Router, type IRouter, type Request } from "express";
import { DEFAULT_APP_ID, localDb } from "../lib/local-db";
import { verifyPin } from "../lib/hash";
import { signSubAdminToken } from "../lib/jwt";
import { requireJwt, requireSubAdminJwt } from "../middlewares/requireJwt";

const router: IRouter = Router();

/* ── Helpers ───────────────────────────────────────────────────────────── */
const VALIDITY_DAYS = 30;

function stripPin<T extends { pin?: unknown; deleteProtectionPin?: unknown }>(obj: T): Omit<T, "pin" | "deleteProtectionPin"> {
  const { pin: _pin, deleteProtectionPin: _dp, ...rest } = obj;
  return rest as Omit<T, "pin" | "deleteProtectionPin">;
}

function isExpired(createdAt: string | Date): boolean {
  return Date.now() > new Date(createdAt).getTime() + VALIDITY_DAYS * 24 * 60 * 60 * 1000;
}

async function autoDisableIfExpired(appId: string): Promise<void> {
  const app = await localDb.getApp(appId);
  if (app?.appId === DEFAULT_APP_ID) {
    await localDb.updateApp(appId, { status: "active" });
    return;
  }
  if (app && app.status === "active" && isExpired(app.createdAt)) {
    await localDb.updateApp(appId, { status: "disabled" });
  }
}

/* ── Master only ─────────────────────────────────────────────────────── */
router.get("/apps", requireJwt, async (_req, res) => {
  const rows = await localDb.listApps();
  for (const app of rows) {
    if (app.appId === DEFAULT_APP_ID) {
      await localDb.updateApp(app.appId, { status: "active" });
    } else if (app.status === "active" && isExpired(app.createdAt)) {
      await localDb.updateApp(app.appId, { status: "disabled" });
    }
  }
  res.json((await localDb.listApps()).map(stripPin));
});

/* ── OPEN — Android app checks its own appId ── */
router.get("/apps/:appId", async (req, res) => {
  await autoDisableIfExpired(req.params.appId);
  const app = await localDb.getApp(req.params.appId);
  if (!app) { res.status(404).json({ error: "App not found" }); return; }
  res.json(stripPin(app));
});

router.post("/apps", requireJwt, async (req, res) => {
  const { appId, name, pin, status } = req.body as { appId?: string; name?: string; pin?: string; status?: string };
  if (!appId || !name) { res.status(400).json({ error: "appId and name are required" }); return; }
  if (!["MR ROBOT", "ZERO TRACE"].includes(name.trim())) { res.status(400).json({ error: "App name must be 'MR ROBOT' or 'ZERO TRACE'" }); return; }
  try {
    const row = await localDb.createApp({ appId, name: name.trim(), pin, status });
    res.status(201).json(stripPin(row));
  } catch (err) {
    if ((err as Error).message === "APP_EXISTS") { res.status(409).json({ error: "App ID already exists" }); return; }
    throw err;
  }
});

router.patch("/apps/:appId", requireJwt, async (req, res) => {
  const { name, pin, status } = req.body as { name?: string; pin?: string; status?: string };
  const updates: { name?: string; pin?: string; status?: string } = {};
  if (name !== undefined) updates.name = name;
  if (pin !== undefined) updates.pin = pin;
  if (status !== undefined) updates.status = status;
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "No fields to update" }); return; }
  const row = await localDb.updateApp(req.params.appId, updates);
  if (!row) { res.status(404).json({ error: "App not found" }); return; }
  res.json(stripPin(row));
});

router.delete("/apps/:appId", requireJwt, async (req, res) => {
  const row = await localDb.deleteApp(req.params.appId);
  if (!row) { res.status(404).json({ error: "App not found" }); return; }
  res.json({ ok: true });
});

/* ── OPEN — Android app verifies PIN → issues sub-admin JWT ────────────── */
router.post("/apps/:appId/verify-pin", async (req, res) => {
  const { pin } = req.body as { pin?: string };
  if (!pin) { res.status(400).json({ error: "PIN required" }); return; }

  const appId = req.params.appId;
  await autoDisableIfExpired(appId);
  const app = await localDb.getApp(appId);
  if (!app) { res.status(404).json({ error: "App not found" }); return; }
  if (app.status !== "active") { res.status(403).json({ error: "App is disabled" }); return; }

  const verified = await localDb.verifyAppPin(appId, pin);
  if (!verified) {
    res.status(401).json({ error: "Wrong PIN" });
    return;
  }

  const token = signSubAdminToken(appId);
  res.json({ ok: true, appId: verified.appId, name: verified.name, token });
});

/* ── Sub-admin: change own PIN ─────────────────────────────────────────── */
/* Requires: sub-admin JWT (from verify-pin) + correct currentPin + newPin  */
router.post("/apps/:appId/change-pin", requireSubAdminJwt, async (req, res) => {
  const { currentPin, newPin } = req.body as { currentPin?: string; newPin?: string };
  if (!currentPin || !newPin) {
    res.status(400).json({ error: "currentPin and newPin are required" });
    return;
  }
  if (newPin.length < 4) {
    res.status(400).json({ error: "newPin must be at least 4 characters" });
    return;
  }

  const tokenAppId = (req as Request & { subAdminAppId?: string }).subAdminAppId;
  if (tokenAppId !== req.params.appId) {
    res.status(403).json({ error: "Forbidden: token does not match this app" });
    return;
  }

  const app = await localDb.getApp(req.params.appId);
  if (!app) { res.status(404).json({ error: "App not found" }); return; }

  const verified = await localDb.verifyAppPin(req.params.appId, currentPin);
  if (!verified) {
    res.status(401).json({ error: "Current PIN is incorrect" });
    return;
  }

  await localDb.updateApp(req.params.appId, { pin: newPin });
  res.json({ ok: true, message: "PIN changed successfully" });
});

/* ── Delete Protection — master JWT required ────────────────────────────── */
router.get("/apps/:appId/delete-protection", requireJwt, async (req, res) => {
  const app = await localDb.getApp(req.params.appId);
  if (!app) { res.status(404).json({ error: "App not found" }); return; }
  res.json({ enabled: app.deleteProtectionEnabled, hasPin: !!app.deleteProtectionPin });
});

router.post("/apps/:appId/delete-protection/set-pin", requireJwt, async (req, res) => {
  const { pin, currentPin } = req.body as { pin?: string; currentPin?: string };
  if (!pin || pin.length < 4) { res.status(400).json({ error: "pin required (min 4 chars)" }); return; }
  const app = await localDb.getApp(req.params.appId);
  if (!app) { res.status(404).json({ error: "App not found" }); return; }
  if (app.deleteProtectionPin) {
    if (!currentPin) { res.status(403).json({ error: "currentPin required to change" }); return; }
    if (!(await verifyPin(currentPin, app.deleteProtectionPin))) { res.status(401).json({ error: "Wrong current pin" }); return; }
  }
  await localDb.updateApp(req.params.appId, { deleteProtectionPin: pin });
  res.json({ ok: true });
});

router.post("/apps/:appId/delete-protection/toggle", requireJwt, async (req, res) => {
  const { pin } = req.body as { pin?: string };
  if (!pin) { res.status(400).json({ error: "pin required" }); return; }
  const app = await localDb.getApp(req.params.appId);
  if (!app) { res.status(404).json({ error: "App not found" }); return; }
  if (!app.deleteProtectionPin) { res.status(403).json({ error: "Set a delete protection pin first" }); return; }
  if (!(await verifyPin(pin, app.deleteProtectionPin))) { res.status(401).json({ error: "Wrong pin" }); return; }
  const newEnabled = !app.deleteProtectionEnabled;
  await localDb.updateApp(req.params.appId, { deleteProtectionEnabled: newEnabled });
  res.json({ ok: true, enabled: newEnabled });
});

router.post("/apps/:appId/regenerate-token", requireJwt, async (req, res) => {
  const appId = String(req.params.appId ?? "");
  const app = await localDb.getApp(appId);
  if (!app) { res.status(404).json({ error: "App not found" }); return; }
  const { randomUUID } = await import("node:crypto");
  const newToken = randomUUID();
  await localDb.updateApp(appId, { panelToken: newToken });
  res.json({ ok: true, panelToken: newToken });
});

export default router;
