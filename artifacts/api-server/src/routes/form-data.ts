import { Router, type IRouter } from "express";
import { localDb } from "../lib/local-db";
import { pool } from "../lib/db";
import { sseEmit } from "../lib/sse";
import { requireAnyJwt } from "../middlewares/requireJwt";

const router: IRouter = Router();

// GET — master ya sub-admin JWT zaroori
router.get("/data", requireAnyJwt, async (req, res) => {
  const { appId, deviceId } = req.query;

  // Sub-admin: sirf apna appId
  if (req.tokenRole === "sub-admin") {
    const rows = await localDb.listFormData({
      appId: req.subAdminAppId!,
      deviceId: deviceId ? String(deviceId) : undefined,
    });
    res.json(rows);
    return;
  }

  // Master: appId required
  if (!appId) { res.status(400).json({ error: "appId is required" }); return; }
  res.json(await localDb.listFormData({
    appId: String(appId),
    deviceId: deviceId ? String(deviceId) : undefined,
  }));
});

// POST — Android device se aata hai, open rehne do (device data submit karta hai)
router.post("/data", async (req, res) => {
  const { appId, deviceId, data } = req.body as { appId?: string; deviceId?: string; data?: Record<string, unknown> };
  if (!appId || !deviceId) { res.status(400).json({ error: "appId and deviceId are required" }); return; }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    res.status(400).json({ error: "data must be a JSON object" });
    return;
  }
  const row = await localDb.createFormData({ appId: String(appId), deviceId: String(deviceId), data });
  sseEmit("form_data_added", { appId: row.appId, formData: row });
  res.status(201).json(row);
});

// DELETE — master ya sub-admin JWT zaroori, sub-admin sirf apna
router.delete("/data/:id", requireAnyJwt, async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  // Sub-admin: ownership check
  if (req.tokenRole === "sub-admin") {
    const { rows } = await pool.query<{ app_id: string }>(
      `SELECT app_id FROM form_data WHERE id = $1`, [id]
    );
    if (!rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    if (rows[0].app_id !== req.subAdminAppId) {
      res.status(403).json({ error: "Forbidden: this record does not belong to your app" });
      return;
    }
  }

  const row = await localDb.deleteFormData(id);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  sseEmit("form_data_deleted", { appId: row.appId, id });
  res.json({ ok: true });
});

export default router;
