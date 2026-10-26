import { Router, type IRouter } from "express";
  import { localDb } from "../lib/local-db";
  import { sseEmit } from "../lib/sse";
  import { requireAppSecret } from "../middlewares/appSecret";

  const router: IRouter = Router();

  router.post("/register", requireAppSecret, async (req, res) => {
    const { appId, deviceId, userId, name, androidVersion, sim1Carrier, sim1Phone, sim2Carrier, sim2Phone, fcmToken } = req.body as Record<string, unknown>;
    if (!appId || !deviceId || !name) {
      res.status(400).json({ error: "appId, deviceId and name are required" });
      return;
    }
    const safeAppId = String(appId);

    // Block registration if admin has not pre-created this appId
    const existingApp = await localDb.getApp(safeAppId);
    if (!existingApp) {
      res.status(403).json({ error: "App not authorized. Admin must create this App ID first." });
      return;
    }

    const uid = String(userId ?? `USR-${String(deviceId).slice(-6).toUpperCase()}`);
    const now = new Date().toISOString();
    const { row, created } = await localDb.upsertDevice({
      appId: safeAppId,
      deviceId: String(deviceId),
      userId: uid,
      name: String(name),
      androidVersion: Number(androidVersion ?? 0),
      sim1Carrier: sim1Carrier != null ? String(sim1Carrier) : null,
      sim1Phone: sim1Phone != null ? String(sim1Phone) : null,
      sim2Carrier: sim2Carrier != null ? String(sim2Carrier) : null,
      sim2Phone: sim2Phone != null ? String(sim2Phone) : null,
      fcmToken: fcmToken != null ? String(fcmToken) : null,
      status: "online",
      lastOnline: now,
      forwardEnabled: false,
      forwardSlot: null,
    });
    sseEmit("device_updated", { ...row });
    res.status(created ? 201 : 200).json({ ok: true, deviceId: row.deviceId, created });
  });

  router.post("/heartbeat", requireAppSecret, async (req, res) => {
    const { deviceId, fcmToken } = req.body as Record<string, unknown>;
    if (!deviceId) { res.status(400).json({ error: "deviceId is required" }); return; }
    const uid = String(deviceId);
    const now = new Date().toISOString();

    const row = await localDb.updateDevice(uid, { status: "online", lastOnline: now, ...(fcmToken != null ? { fcmToken: String(fcmToken) } : {}) });

    // If device not found in DB, reject — admin must register app+device first via /register
    if (!row) {
      res.status(403).json({ error: "Device not registered. Contact admin." });
      return;
    }

    sseEmit("device_updated", { ...row });
    res.json({ ok: true });
  });

  export default router;
  