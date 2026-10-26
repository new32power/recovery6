import { Router } from "express";
import type { Request, Response } from "express";

const router = Router();
const VPS = "http://45.128.12.30:3456";

async function proxyJson(req: Request, res: Response, path: string, method = "GET", body?: unknown) {
  try {
    const r = await fetch(`${VPS}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch {
    res.status(502).json({ error: "VPS server unavailable" });
  }
}

router.get("/vps/api/apps", (req, res) => proxyJson(req, res, "/api/apps"));

router.post("/vps/api/verify-token", (req, res) =>
  proxyJson(req, res, "/api/verify-token", "POST", req.body));

router.post("/vps/api/build/start", (req, res) =>
  proxyJson(req, res, "/api/build/start", "POST", req.body));

router.get("/vps/api/build/:jobId/info", (req, res) =>
  proxyJson(req, res, `/api/build/${req.params.jobId}/info`));

// SSE proxy
router.get("/vps/api/build/:jobId/status", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  try {
    const upstream = await fetch(`${VPS}/api/build/${req.params.jobId}/status`);
    const reader = upstream.body?.getReader();
    if (!reader) { res.end(); return; }
    const decoder = new TextDecoder();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        const text = decoder.decode(value, { stream: true });
        res.write(text);
        if (text.includes('"done"') || text.includes('"error"')) { res.end(); break; }
      }
    };
    pump().catch(() => res.end());
    req.on("close", () => reader.cancel());
  } catch {
    res.write("data: " + JSON.stringify({ status: "error", message: "VPS connect fail" }) + "\n\n");
    res.end();
  }
});

// Download proxy
router.get("/vps/api/build/:jobId/download", async (req, res) => {
  try {
    const upstream = await fetch(`${VPS}/api/build/${req.params.jobId}/download`);
    if (!upstream.ok) { res.status(404).json({ error: "File not ready" }); return; }
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    const cd = upstream.headers.get("content-disposition");
    if (cd) res.setHeader("Content-Disposition", cd);
    const cl = upstream.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);
    const reader = upstream.body?.getReader();
    if (!reader) { res.end(); return; }
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        res.write(Buffer.from(value));
      }
    };
    pump().catch(() => res.end());
  } catch {
    res.status(502).json({ error: "Download failed" });
  }
});

export default router;
