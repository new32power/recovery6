import { Router, type IRouter } from "express";
import { localDb } from "../lib/local-db";

const router: IRouter = Router();

router.get("/sample", async (req, res) => {
  res.json(await localDb.sample(req.query.appId ? String(req.query.appId) : undefined));
});

export default router;
