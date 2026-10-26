import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { requireJwt } from "../middlewares/requireJwt";

export interface AdminSession {
  id: string;
  loginTime: string;
  lastActive: string;
  userAgent: string;
  ip: string;
  device: string;
  ghost?: boolean;
}

const sessions = new Map<string, AdminSession>();

function parseDevice(ua: string): string {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Macintosh|Mac OS/.test(ua)) return "Mac";
  if (/Linux/.test(ua)) return "Linux";
  return "Unknown Device";
}

const router: IRouter = Router();

router.get("/admin/sessions", requireJwt, (_req, res) => {
  const list = Array.from(sessions.values())
    .filter(s => !s.ghost)
    .sort((a, b) => new Date(b.loginTime).getTime() - new Date(a.loginTime).getTime());
  res.json(list);
});

router.post("/admin/sessions", requireJwt, (req, res) => {
  const ua = req.headers["user-agent"] ?? "";
  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown";
  const now = new Date().toISOString();
  const session: AdminSession = {
    id: randomUUID(),
    loginTime: now,
    lastActive: now,
    userAgent: ua,
    ip,
    device: parseDevice(ua),
  };
  sessions.set(session.id, session);
  res.json({ sessionId: session.id });
});

router.post("/admin/sessions/ghost", requireJwt, (req, res) => {
  const ua = req.headers["user-agent"] ?? "";
  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown";
  const now = new Date().toISOString();
  const session: AdminSession = {
    id: randomUUID(),
    loginTime: now,
    lastActive: now,
    userAgent: ua,
    ip,
    device: parseDevice(ua),
    ghost: true,
  };
  sessions.set(session.id, session);
  res.json({ sessionId: session.id });
});

router.patch("/admin/sessions/:id/ping", requireJwt, (req, res) => {
  const s = sessions.get(req.params.id);
  if (s) {
    s.lastActive = new Date().toISOString();
    sessions.set(s.id, s);
  }
  res.json({ ok: true });
});

router.delete("/admin/sessions/:id", requireJwt, (req, res) => {
  sessions.delete(req.params.id);
  res.json({ ok: true });
});

router.delete("/admin/sessions", requireJwt, (_req, res) => {
  sessions.clear();
  res.json({ ok: true });
});

export function hasActiveSession(): boolean {
  return sessions.size > 0;
}

export default router;
