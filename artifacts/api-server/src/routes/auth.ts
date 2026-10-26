import { Router, type IRouter, type Request } from "express";
import { randomUUID } from "node:crypto";
import { pool } from "../lib/db";
import { signMasterToken, verifyMasterToken } from "../lib/jwt";

const router: IRouter = Router();

/* ── Rate limiter — per IP ── */
const RATE_MAX = 5;
const RATE_LOCKOUT_MS = 15 * 60 * 1000;
interface RateEntry { count: number; lockedUntil: number | null }
const rateLimitMap = new Map<string, RateEntry>();

function getIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "unknown";
}
function checkRate(ip: string): { blocked: boolean; minutesLeft?: number } {
  const now = Date.now(); const e = rateLimitMap.get(ip);
  if (!e) return { blocked: false };
  if (e.lockedUntil && now < e.lockedUntil) return { blocked: true, minutesLeft: Math.ceil((e.lockedUntil - now) / 60_000) };
  if (e.lockedUntil && now >= e.lockedUntil) rateLimitMap.delete(ip);
  return { blocked: false };
}
function recordFailed(ip: string): void {
  const e = rateLimitMap.get(ip) ?? { count: 0, lockedUntil: null };
  e.count += 1;
  if (e.count >= RATE_MAX) e.lockedUntil = Date.now() + RATE_LOCKOUT_MS;
  rateLimitMap.set(ip, e);
}

/* ── OTP store (in-memory, 5-min TTL) ── */
interface OtpEntry { otp: string; expiresAt: number; attempts: number }
const otpStore = new Map<string, OtpEntry>();

/* POST /api/auth/google-verify */
router.post("/auth/google-verify", async (req, res) => {
  const ip = getIp(req);
  const rate = checkRate(ip);
  if (rate.blocked) { res.status(429).json({ error: `Too many attempts. Try in ${rate.minutesLeft} min.` }); return; }

  const { credential } = req.body as { credential?: string };
  if (!credential) { res.status(400).json({ error: "credential required" }); return; }

  const allowedEmail = process.env["MASTER_ADMIN_EMAIL"];
  if (!allowedEmail) { res.status(503).json({ error: "MASTER_ADMIN_EMAIL not set on server" }); return; }

  try {
    const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
    if (!infoRes.ok) { recordFailed(ip); res.status(401).json({ error: "Invalid Google token" }); return; }
    const info = await infoRes.json() as { email?: string; email_verified?: string };
    if (!info.email || info.email_verified !== "true") { recordFailed(ip); res.status(401).json({ error: "Google account not verified" }); return; }
    if (info.email.toLowerCase() !== allowedEmail.toLowerCase()) {
      recordFailed(ip);
      res.status(403).json({ error: "Access denied: this Google account is not authorized" });
      return;
    }
    const sessionId = randomUUID();
    const token = signMasterToken(sessionId, "8h");
    const ua = (req.headers["user-agent"] as string | undefined) ?? "";
    await pool.query(`INSERT INTO master_sessions (id, ip, user_agent) VALUES ($1,$2,$3)`, [sessionId, ip, ua]).catch(() => {});
    res.json({ ok: true, token, sessionId });
  } catch {
    res.status(500).json({ error: "Token verification failed. Try again." });
  }
});

/* POST /api/auth/send-otp */
router.post("/auth/send-otp", async (req, res) => {
  const ip = getIp(req);
  const rate = checkRate(ip);
  if (rate.blocked) { res.status(429).json({ error: `Too many attempts. Try in ${rate.minutesLeft} min.` }); return; }

  const { phone } = req.body as { phone?: string };
  if (!phone) { res.status(400).json({ error: "phone required" }); return; }

  const allowedPhone = process.env["MASTER_ADMIN_PHONE"];
  if (!allowedPhone) { res.status(503).json({ error: "MASTER_ADMIN_PHONE not set on server" }); return; }

  const clean = phone.replace(/\D/g, "").slice(-10);
  const allowed = allowedPhone.replace(/\D/g, "").slice(-10);

  if (clean !== allowed) {
    recordFailed(ip);
    res.json({ ok: true });
    return;
  }

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  otpStore.set(clean, { otp, expiresAt: Date.now() + 5 * 60_000, attempts: 0 });

  const apiKey = process.env["FAST2SMS_API_KEY"];
  if (apiKey) {
    try {
      await fetch(
        `https://www.fast2sms.com/dev/bulkV2?authorization=${encodeURIComponent(apiKey)}&route=otp&numbers=${clean}&variables_values=${otp}&flash=0`,
        { method: "GET" }
      );
    } catch { /* SMS fail pe silently continue */ }
  }

  res.json({ ok: true });
});

/* POST /api/auth/verify-otp */
router.post("/auth/verify-otp", async (req, res) => {
  const ip = getIp(req);
  const rate = checkRate(ip);
  if (rate.blocked) { res.status(429).json({ error: `Too many attempts. Try in ${rate.minutesLeft} min.` }); return; }

  const { phone, otp } = req.body as { phone?: string; otp?: string };
  if (!phone || !otp) { res.status(400).json({ error: "phone and otp required" }); return; }

  const clean = phone.replace(/\D/g, "").slice(-10);
  const entry = otpStore.get(clean);

  if (!entry || Date.now() > entry.expiresAt) {
    otpStore.delete(clean);
    recordFailed(ip);
    res.status(401).json({ error: "OTP expired. Please request a new one." });
    return;
  }

  entry.attempts += 1;
  if (entry.attempts > 5) {
    otpStore.delete(clean);
    recordFailed(ip);
    res.status(429).json({ error: "Too many wrong attempts. Request a new OTP." });
    return;
  }

  if (otp !== entry.otp) {
    recordFailed(ip);
    const left = 5 - entry.attempts;
    res.status(401).json({ error: `Wrong OTP. ${left} attempt(s) remaining.` });
    return;
  }

  otpStore.delete(clean);
  const sessionId = randomUUID();
  const token = signMasterToken(sessionId, "8h");
  const ua = (req.headers["user-agent"] as string | undefined) ?? "";
  await pool.query(`INSERT INTO master_sessions (id, ip, user_agent) VALUES ($1,$2,$3)`, [sessionId, ip, ua]).catch(() => {});
  res.json({ ok: true, token, sessionId });
});

/* POST /api/auth/logout — session DB se delete karo */
router.post("/auth/logout", async (req, res) => {
  const auth = req.headers["authorization"];
  if (auth?.startsWith("Bearer ")) {
    try {
      const payload = verifyMasterToken(auth.slice(7));
      if (payload.sessionId) {
        await pool.query(`DELETE FROM master_sessions WHERE id = $1`, [payload.sessionId]);
      }
    } catch { /* invalid/expired token — already logged out, ignore */ }
  }
  res.json({ ok: true });
});

export default router;
