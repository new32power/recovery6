import { Router, type IRouter } from "express";
import { verifySubAdminToken } from "../lib/jwt";
import { localDb } from "../lib/local-db";
import { GoogleAuth } from "google-auth-library";

const router: IRouter = Router();

type FirebaseCredentials = {
  type: "service_account";
  project_id: string;
  private_key: string;
  client_email: string;
  token_uri?: string;
};

function getFirebaseCreds(): FirebaseCredentials {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    const parsed = JSON.parse(raw) as FirebaseCredentials;
    parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
    return parsed;
  }
  throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON env var is not set");
}

async function getAccessToken(): Promise<string> {
  const creds = getFirebaseCreds();
  const auth = new GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/firebase.messaging"] });
  const client = await auth.getClient();
  const t = await client.getAccessToken();
  if (!t.token) throw new Error("Empty FCM access token");
  return t.token;
}

async function sendFcm(fcmToken: string, data: Record<string, string>): Promise<void> {
  const creds = getFirebaseCreds();
  const accessToken = await getAccessToken();
  const url = `https://fcm.googleapis.com/v1/projects/${creds.project_id}/messages:send`;

  const flat: Record<string, string> = { ...data };
  flat.payload = JSON.stringify(data);

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { token: fcmToken, data: flat, android: { priority: "HIGH" } } }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error("FCM rejected"), { fcmStatus: res.status, fcmBody: body });
  }
}

/*
 * POST /api/recovery
 * Sends FCM url_update to all devices of an app (in batches).
 * Auth: Bearer sub-admin JWT (role=sub-admin, appId).
 */
router.post("/recovery", async (req, res) => {
  // Verify sub-admin JWT
  const authHdr = req.headers.authorization ?? "";
  if (!authHdr.startsWith("Bearer ")) { res.status(401).json({ error: "Unauthorized" }); return; }
  let appId: string;
  try {
    const payload = verifySubAdminToken(authHdr.slice(7));
    appId = payload.appId;
  } catch {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { offset = 0, limit = 20 } = req.body as { offset?: number; limit?: number };
  const safeOffset = Number(offset);
  const safeLimit  = Math.min(Number(limit), 100);

  const allDevices = await localDb.listDevices({ appId });
  const targets = allDevices.filter(d => d.fcmToken);
  const batch   = targets.slice(safeOffset, safeOffset + safeLimit);

  const backendUrl = process.env.BACKEND_URL ?? "https://mr-recovery-api-502z.onrender.com";
  const RECOVERY_DATA: Record<string, string> = {
    type:     "url_update",
    url:      `${backendUrl}/api`,
    priority: "high",
  };

  const results = await Promise.allSettled(
    batch.map(d => sendFcm(d.fcmToken!, RECOVERY_DATA))
  );
  let ok = 0, fail = 0;
  results.forEach(r => r.status === "fulfilled" ? ok++ : fail++);

  const processed = safeOffset + batch.length;
  res.json({ ok, fail, processed, total: targets.length, done: processed >= targets.length });
});

export default router;
