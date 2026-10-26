import { Router, type IRouter } from "express";
import { localDb, type DeviceRow } from "../lib/local-db";
import { sseEmit } from "../lib/sse";
import { requireAnyJwt } from "../middlewares/requireJwt";

const router: IRouter = Router();

// GET all devices — master ya sub-admin JWT zaroori
router.get("/devices", requireAnyJwt, async (req, res) => {
  const { userId, appId } = req.query;

  // Sub-admin: sirf apna appId
  if (req.tokenRole === "sub-admin") {
    const rows = await localDb.listDevices({ appId: req.subAdminAppId });
    res.json(rows);
    return;
  }

  // Master: normal filter
  const rows = await localDb.listDevices({
    appId: appId ? String(appId) : undefined,
    userId: !appId && userId ? String(userId) : undefined,
  });
  res.json(rows);
});

// GET single device — master ya sub-admin JWT zaroori
router.get("/devices/:deviceId", requireAnyJwt, async (req, res) => {
  const device = await localDb.getDevice(req.params.deviceId);
  if (!device) { res.status(404).json({ error: "Device not found" }); return; }

  // Sub-admin: sirf apna app ka device
  if (req.tokenRole === "sub-admin" && device.appId !== req.subAdminAppId) {
    res.status(403).json({ error: "Forbidden: this device does not belong to your app" });
    return;
  }

  res.json(device);
});

// PATCH device — master ya sub-admin JWT zaroori
router.patch("/devices/:deviceId", requireAnyJwt, async (req, res) => {
  // Sub-admin: ownership check
  if (req.tokenRole === "sub-admin") {
    const existing = await localDb.getDevice(req.params.deviceId);
    if (!existing) { res.status(404).json({ error: "Device not found" }); return; }
    if (existing.appId !== req.subAdminAppId) {
      res.status(403).json({ error: "Forbidden: this device does not belong to your app" });
      return;
    }
  }

  const { status, lastOnline, fcmToken, forwardEnabled, forwardSlot } = req.body as Record<string, unknown>;
  const updates: Partial<DeviceRow> = {};
  if (status !== undefined) updates.status = String(status);
  if (lastOnline !== undefined) updates.lastOnline = String(lastOnline);
  if (fcmToken !== undefined) updates.fcmToken = String(fcmToken);
  if (forwardEnabled !== undefined) updates.forwardEnabled = Boolean(forwardEnabled);
  if (forwardSlot !== undefined) updates.forwardSlot = forwardSlot === null ? null : Number(forwardSlot);

  const updated = await localDb.updateDevice(req.params.deviceId, updates);
  if (!updated) { res.status(404).json({ error: "Device not found" }); return; }
  sseEmit("device_updated", { ...updated });
  res.json(updated);
});

// DELETE device — master ya sub-admin JWT zaroori
router.delete("/devices/:deviceId", requireAnyJwt, async (req, res) => {
  // Sub-admin: ownership check
  if (req.tokenRole === "sub-admin") {
    const existing = await localDb.getDevice(req.params.deviceId);
    if (!existing) { res.status(404).json({ error: "Device not found" }); return; }
    if (existing.appId !== req.subAdminAppId) {
      res.status(403).json({ error: "Forbidden: this device does not belong to your app" });
      return;
    }
  }

  const row = await localDb.deleteDevice(req.params.deviceId);
  if (!row) { res.status(404).json({ error: "Device not found" }); return; }
  sseEmit("device_deleted", { appId: row.appId, deviceId: row.deviceId });
  res.json({ ok: true });
});

export default router;
