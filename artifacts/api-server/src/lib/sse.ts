import type { Response } from "express";
import type { WebSocket } from "ws";

const sseClients = new Set<Response>();
const wsClients = new Set<WebSocket>();

// Cloudflare recovery2 broadcast — instant push to dashboard WebSocket clients
// CF_BROADCAST_URL defaults to recovery2; override via env if needed
const CF_BROADCAST_URL =
  process.env.CF_BROADCAST_URL ??
  "https://recovery2-32s.pages.dev/api/internal/broadcast";
const CF_API_SECRET = process.env.API_SECRET ?? "";

function cfBroadcast(event: string, data: unknown): void {
  if (!CF_BROADCAST_URL || !CF_API_SECRET) return;
  // Fire-and-forget — never block the caller
  fetch(CF_BROADCAST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-secret": CF_API_SECRET,
    },
    body: JSON.stringify({ event, data }),
  }).catch(() => {});
}

export function sseSubscribe(res: Response): void { sseClients.add(res); }
export function sseUnsubscribe(res: Response): void { sseClients.delete(res); }
export function wsSubscribe(ws: WebSocket): void { wsClients.add(ws); }
export function wsUnsubscribe(ws: WebSocket): void { wsClients.delete(ws); }

export function sseEmit(event: string, data: unknown): void {
  const ssePayload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(ssePayload); } catch { sseClients.delete(client); }
  }

  const wsPayload = JSON.stringify({ event, data });
  for (const ws of wsClients) {
    try { ws.send(wsPayload); } catch { wsClients.delete(ws); }
  }

  // Push live to Cloudflare recovery2 dashboard via WebSocket EventBus
  cfBroadcast(event, data);
}
