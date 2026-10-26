import { Router, type IRouter } from "express";
import { localDb } from "../lib/local-db";
import { requireAnyJwt } from "../middlewares/requireJwt";

const router: IRouter = Router();

router.get("/stats", requireAnyJwt, async (req, res) => {
  // Sub-admin: sirf apna appId ka stats
  if (req.tokenRole === "sub-admin") {
    res.json(await localDb.stats(req.subAdminAppId));
    return;
  }
  // Master: normal
  res.json(await localDb.stats(req.query.appId ? String(req.query.appId) : undefined));
});

export default router;
