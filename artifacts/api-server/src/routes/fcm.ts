import { Router, type IRouter, type Request } from "express";
import { GoogleAuth } from "google-auth-library";
import { localDb } from "../lib/local-db";

const router: IRouter = Router();

type FirebaseCredentials = {
  type: "service_account";
  project_id: string;
  private_key: string;
  client_email: string;
  token_uri?: string;
};

function normalizePrivateKey(raw: string): string {
  let key = raw.trim();
  // Strip surrounding quotes if user pasted them
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  // Convert literal \n to real newlines
  key = key.replace(/\\n/g, "\n");
  // Ensure trailing newline (PEM strict format)
  if (!key.endsWith("\n")) key += "\n";
  return key;
}

function getFirebaseCredentials(): FirebaseCredentials {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON) as FirebaseCredentials;
    parsed.private_key = normalizePrivateKey(parsed.private_key);
    return parsed;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const rawKey = process.env.FIREBASE_PRIVATE_KEY;
  const privateKey = rawKey ? normalizePrivateKey(rawKey) : undefined;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Firebase FCM env missing. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in .env or hosting secrets.");
  }

  return {
    type: "service_account",
    project_id: projectId,
    client_email: clientEmail,
    private_key: privateKey,
    token_uri: "https://oauth2.googleapis.com/token",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getAccessTokenWithRetry(credentials: FirebaseCredentials, req?: Request): Promise<string> {
  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
  });

  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const client = await auth.getClient();
      const tokenResponse = await client.getAccessToken();
      const accessToken = tokenResponse.token;
      if (!accessToken) throw new Error("Empty access token from Google");
      return accessToken;
    } catch (err) {
      lastErr = err;
      const errMsg = err instanceof Error ? err.message : String(err);
      const transient = errMsg.includes("ETIMEDOUT") || errMsg.includes("ECONNRESET") || errMsg.includes("503") || errMsg.includes("500");
      req?.log.warn({ attempt, errMsg, transient, keyEmail: credentials.client_email, projectId: credentials.project_id, keyLen: credentials.private_key.length, keyStartsWith: credentials.private_key.slice(0, 30), keyEndsWith: credentials.private_key.slice(-30) }, "Google auth attempt failed");
      if (attempt < MAX_ATTEMPTS && transient) {
        await sleep(400 * attempt); // 400ms, 800ms backoff
        continue;
      }
      break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function sendFcmToToken(fcmToken: string, data: Record<string, string>, deviceId?: string, req?: Request): Promise<{ messageId: string }> {
  const credentials = getFirebaseCredentials();
  const accessToken = await getAccessTokenWithRetry(credentials, req);

  const fcmUrl = `https://fcm.googleapis.com/v1/projects/${credentials.project_id}/messages:send`;
  const body = JSON.stringify({ message: { token: fcmToken, data } });

  const fcmRes = await fetch(fcmUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body,
  });

  const fcmBody = await fcmRes.json() as Record<string, unknown>;
  if (!fcmRes.ok) {
    req?.log.warn({ deviceId, fcmStatus: fcmRes.status, fcmBody }, "FCM send failed");
    throw Object.assign(new Error("FCM rejected"), { fcmStatus: fcmRes.status, fcmBody });
  }

  req?.log.info({ deviceId, messageId: fcmBody["name"], data }, "FCM message sent");
  return { messageId: String(fcmBody["name"] ?? "sent") };
}

router.post("/fcm/send", async (req, res) => {
  const { deviceId, data } = req.body as { deviceId?: string; data?: Record<string, string> };
  if (!deviceId) { res.status(400).json({ error: "deviceId is required" }); return; }
  if (!data || typeof data !== "object") { res.status(400).json({ error: "data object is required" }); return; }

  const device = await localDb.getDevice(String(deviceId));
  if (!device) { res.status(404).json({ error: "Device not found" }); return; }
  if (!device.fcmToken) { res.status(422).json({ error: "Device has no FCM token registered" }); return; }

  const safeData: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) safeData[k] = String(v);

  try {
    const result = await sendFcmToToken(device.fcmToken, safeData, deviceId, req);
    res.json({ success: true, messageId: result.messageId });
  } catch (err: unknown) {
    const e = err as Error & { fcmStatus?: number; fcmBody?: unknown };
    const body = e.fcmBody as { error?: { message?: string; details?: Array<{ errorCode?: string }> } } | undefined;
    const errorCode = body?.error?.details?.[0]?.errorCode;
    const msg = body?.error?.message;
    if (e.fcmStatus === 404 || errorCode === "UNREGISTERED") {
      res.status(410).json({ error: "Device unreachable.", detail: msg });
      return;
    }
    if (e.fcmStatus === 400 && (msg?.includes("not a valid FCM registration token") || msg?.includes("INVALID_ARGUMENT"))) {
      res.status(400).json({ error: "Device unreachable.", detail: msg });
      return;
    }
    if (e.fcmStatus) { res.status(e.fcmStatus).json({ error: e.fcmBody }); return; }
    res.status(500).json({ error: e.message });
  }
});

router.post("/fcm/online-check", async (req, res) => {
  const { token, data } = req.body as { token?: string; data?: Record<string, string> };
  if (!token) { res.status(400).json({ error: "token is required" }); return; }
  try {
    const safeData: Record<string, string> = {};
    for (const [k, v] of Object.entries(data ?? { type: "online_check" })) safeData[k] = String(v);
    const result = await sendFcmToToken(token, safeData, undefined, req);
    res.json({ success: true, messageId: result.messageId });
  } catch (err: unknown) {
    const e = err as Error & { fcmStatus?: number; fcmBody?: unknown };
    if (e.fcmStatus) { res.status(e.fcmStatus).json({ error: e.fcmBody }); return; }
    res.status(500).json({ error: e.message });
  }
});

export default router;
