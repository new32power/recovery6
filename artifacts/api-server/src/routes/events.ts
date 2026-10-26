import { Router, type IRouter } from "express";
import { sseSubscribe, sseUnsubscribe } from "../lib/sse";
import { requireAnyJwt } from "../middlewares/requireJwt";

const router: IRouter = Router();

// Sub-admin events — requireAnyJwt se protect kiya
router.get("/events", requireAnyJwt, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  res.write(":ping\n\n");

  sseSubscribe(res);

  const keepAlive = setInterval(() => {
    try { res.write(":ping\n\n"); } catch { clearInterval(keepAlive); }
  }, 20000);

  req.on("close", () => {
    clearInterval(keepAlive);
    sseUnsubscribe(res);
  });
});

export default router;
