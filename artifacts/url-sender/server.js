import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pkg from 'pg';
const { Pool } = pkg;
import { GoogleAuth } from 'google-auth-library';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4500;

const NEON_URL = process.env.NEON_DATABASE_URL || 'postgresql://neondb_owner:npg_eBGvFC0Pi7Yh@ep-lingering-haze-aquknql6-pooler.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require';

const FIREBASE_SA = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  : null;
if (!FIREBASE_SA) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON env secret not set!');

const pool = new Pool({ connectionString: NEON_URL });

async function query(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function getFcmToken() {
  const auth = new GoogleAuth({
    credentials: FIREBASE_SA,
    scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
  });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  return tokenResponse.token;
}

async function sendFcmToToken(fcmToken, data) {
  const accessToken = await getFcmToken();
  const projectId = FIREBASE_SA.project_id;
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        token: fcmToken,
        data: (() => {
          const flat = Object.fromEntries(
            Object.entries(data).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])
          );
          flat.payload = JSON.stringify(data); // nested payload bhi
          return flat;
        })(),
        android: { priority: 'HIGH' },
      }
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || 'FCM error');
  return json;
}

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

app.use((req, res, next) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Stats
app.get('/api/stats', async (req, res) => {
  try {
    const [[apps], [devs], [msgs], [online], [fcmOk]] = await Promise.all([
      query('SELECT COUNT(*) cnt FROM apps'),
      query('SELECT COUNT(*) cnt FROM devices'),
      query('SELECT COUNT(*) cnt FROM messages'),
      query("SELECT COUNT(*) cnt FROM devices WHERE status='online'"),
      query('SELECT COUNT(*) cnt FROM devices WHERE fcm_token IS NOT NULL'),
    ]);
    res.json({ apps: +apps.cnt, devices: +devs.cnt, messages: +msgs.cnt, online: +online.cnt, fcmReady: +fcmOk.cnt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Apps
app.get('/api/apps', async (req, res) => {
  try {
    const rows = await query(`
      SELECT a.app_id, a.name, a.status,
             COUNT(d.id)::int AS device_count,
             COUNT(CASE WHEN d.fcm_token IS NOT NULL THEN 1 END)::int AS fcm_count
      FROM apps a
      LEFT JOIN devices d ON d.app_id = a.app_id
      GROUP BY a.id, a.app_id, a.name, a.status ORDER BY a.id
    `);
    res.json(rows.map(r => ({ appId: r.app_id, name: r.name, status: r.status, deviceCount: r.device_count, fcmCount: r.fcm_count })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Devices
app.post('/api/fcm/send-batch', async (req, res) => {
  try {
    const { data, offset = 0, limit = 30 } = req.body;
    const rows = await query(
      'SELECT device_id, app_id, name, fcm_token FROM devices WHERE fcm_token IS NOT NULL ORDER BY id OFFSET $1 LIMIT $2',
      [offset, limit]
    );
    const [{ cnt }] = await query('SELECT COUNT(*) cnt FROM devices WHERE fcm_token IS NOT NULL');
    const results = await Promise.all(rows.map(async (r, i) => {
      try {
        await sendFcmToToken(r.fcm_token, data || {});
        return { n: offset + i + 1, deviceId: r.device_id, appId: r.app_id, name: r.name, ok: true, status: 200 };
      } catch (e) {
        return { n: offset + i + 1, deviceId: r.device_id, appId: r.app_id, name: r.name, ok: false, status: 500, msg: e.message };
      }
    }));
    res.json({ results, total: +cnt, offset, limit, nextOffset: offset + rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/devices', async (req, res) => {
  try {
    const { appId } = req.query;
    const rows = appId
      ? await query('SELECT device_id,app_id,name,status,fcm_token,sim1_phone,sim2_phone FROM devices WHERE app_id=$1 ORDER BY name', [appId])
      : await query('SELECT device_id,app_id,name,status,(fcm_token IS NOT NULL) AS has_fcm FROM devices ORDER BY app_id,name');
    res.json(rows.map(r => ({ deviceId: r.device_id, appId: r.app_id, name: r.name, status: r.status, hasFcm: !!(r.fcm_token || r.has_fcm), sim1: r.sim1_phone || null, sim2: r.sim2_phone || null })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// FCM Send
app.post('/api/fcm/send', async (req, res) => {
  try {
    const { deviceId, appId, data } = req.body;
    let tokens = [];

    if (deviceId) {
      const rows = await query('SELECT fcm_token FROM devices WHERE device_id=$1 AND fcm_token IS NOT NULL', [deviceId]);
      tokens = rows.map(r => ({ deviceId, appId: appId || '', name: deviceId, fcmToken: r.fcm_token }));
    } else if (appId) {
      const rows = await query('SELECT device_id, name, fcm_token FROM devices WHERE app_id=$1 AND fcm_token IS NOT NULL', [appId]);
      tokens = rows.map(r => ({ deviceId: r.device_id, appId, name: r.name, fcmToken: r.fcm_token }));
    } else {
      return res.status(400).json({ error: 'deviceId or appId required' });
    }

    if (tokens.length === 0) return res.json({ results: [], sent: 0, failed: 0, message: 'No FCM tokens found' });

    const results = await Promise.all(tokens.map(async (t) => {
      try {
        await sendFcmToToken(t.fcmToken, data || {});
        return { deviceId: t.deviceId, appId: t.appId, name: t.name, ok: true, status: 200 };
      } catch (err) {
        return { deviceId: t.deviceId, appId: t.appId, name: t.name, ok: false, status: 500, msg: err.message };
      }
    }));

    res.json({ results, sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  if (req.path === '/') return res.sendFile(join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log(`MR URL Sender running on port ${PORT}`));
