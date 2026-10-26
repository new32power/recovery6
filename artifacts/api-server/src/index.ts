import { WebSocketServer } from "ws";
import app from "./app";
import { logger } from "./lib/logger";
import { initDb, pool } from "./lib/db";
import { wsSubscribe, wsUnsubscribe } from "./lib/sse";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function main() {
  await initDb();
  const server = app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info({ port }, "Server listening");
  });

  // WebSocket server for real-time pub-sub on /api/events
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = req.url || "";
    if (url === "/api/events" || url.startsWith("/api/events?")) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wsSubscribe(ws);
        try {
          ws.send(JSON.stringify({ event: "ping", data: { t: Date.now() } }));
        } catch {}
        ws.on("close", () => wsUnsubscribe(ws));
        ws.on("error", () => wsUnsubscribe(ws));
      });
    } else {
      socket.destroy();
    }
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "Shutting down…");
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
