import type { Request, Response, NextFunction } from "express";
import { verifyMasterToken, verifySubAdminToken } from "../lib/jwt";
import { pool } from "../lib/db";

// Extend Request with token info
declare module "express-serve-static-core" {
  interface Request {
    tokenRole?: "master" | "sub-admin";
    subAdminAppId?: string;
    masterSessionId?: string;
  }
}

export function requireJwt(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authorization header missing or invalid" });
    return;
  }
  const token = auth.slice(7);

  let payload: ReturnType<typeof verifyMasterToken>;
  try {
    payload = verifyMasterToken(token);
    if (payload.role !== "master") {
      res.status(403).json({ error: "Forbidden: insufficient role" });
      return;
    }
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  const sessionId = payload.sessionId;
  if (!sessionId) {
    res.status(401).json({ error: "Token missing session — please login again" });
    return;
  }

  pool.query<{ id: string }>(
    `SELECT id FROM master_sessions WHERE id = $1`,
    [sessionId]
  ).then(result => {
    if (result.rows.length === 0) {
      res.status(401).json({ error: "Session revoked — please login again" });
      return;
    }
    req.tokenRole = "master";
    req.masterSessionId = sessionId;
    next();
  }).catch(() => {
    res.status(503).json({ error: "Auth check failed. Please try again." });
  });
}

export function requireSubAdminJwt(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authorization header missing or invalid" });
    return;
  }
  const token = auth.slice(7);
  try {
    const payload = verifySubAdminToken(token);
    req.tokenRole = "sub-admin";
    req.subAdminAppId = payload.appId;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired sub-admin token" });
  }
}

// Master ya sub-admin — dono accept karta hai
export function requireAnyJwt(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authorization header missing or invalid" });
    return;
  }
  const token = auth.slice(7);

  // Pehle master try karo
  try {
    const payload = verifyMasterToken(token);
    if (payload.role === "master" && payload.sessionId) {
      pool.query<{ id: string }>(
        `SELECT id FROM master_sessions WHERE id = $1`,
        [payload.sessionId]
      ).then(result => {
        if (result.rows.length === 0) {
          res.status(401).json({ error: "Session revoked — please login again" });
          return;
        }
        req.tokenRole = "master";
        req.masterSessionId = payload.sessionId;
        next();
      }).catch(() => {
        res.status(503).json({ error: "Auth check failed. Please try again." });
      });
      return;
    }
  } catch { /* master verify fail — sub-admin try karo */ }

  // Phir sub-admin try karo
  try {
    const payload = verifySubAdminToken(token);
    req.tokenRole = "sub-admin";
    req.subAdminAppId = payload.appId;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
