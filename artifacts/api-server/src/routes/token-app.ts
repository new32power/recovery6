import { Router, type IRouter } from "express";
import { pool } from "../lib/db";
import { requireJwt } from "../middlewares/requireJwt";

const router: IRouter = Router();

/* OPEN — Android app fetches its apkId via token */
router.get("/token-app", async (req, res) => {
  const token = req.query.token ? String(req.query.token) : null;
  if (!token) { res.status(400).json({ error: "token required" }); return; }
  const key = `token_app:${token}`;
  const result = await pool.query<{ value: string }>(
    `SELECT value FROM settings WHERE key = $1`, [key]
  );
  const apkId = result.rows[0]?.value ?? null;
  res.json({ apkId });
});

/* JWT protected — only master can create/delete mappings */
router.post("/token-app", requireJwt, async (req, res) => {
  const { token, apkId } = req.body as { token?: string; apkId?: string };
  if (!token || !apkId) { res.status(400).json({ error: "token and apkId required" }); return; }
  const key = `token_app:${token}`;
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
    [key, apkId]
  );
  res.json({ ok: true });
});

router.delete("/master/token-app/:appId", requireJwt, async (req, res) => {
  const key = `token_app:${req.params.appId}`;
  const result = await pool.query(`DELETE FROM settings WHERE key = $1 RETURNING key`, [key]);
  res.json({ ok: true, deleted: result.rowCount ?? 0 });
});

export default router;
