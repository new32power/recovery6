import { Router, type IRouter } from "express";
  import { env } from "../lib/env";
  import { requireAppSecret } from "../middlewares/appSecret";

  const router: IRouter = Router();

  /**
   * Proxy relay — Android app sends requests here.
   * Validates X-App-Secret, then forwards to the actual backend.
   * The real backend URL (PROXY_TARGET) stays hidden from the APK.
   *
   * Android API_BASE_URL → https://<replit-domain>/api/relay
   * Actual backend        → https://mr-robot-5s3.pages.dev/api  (env: PROXY_TARGET)
   */
  router.all("/relay/*splat", requireAppSecret, async (req, res) => {
    const splat: string = (req.params as Record<string, string>)["splat"] ?? "";
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const targetUrl = `${env.proxyTarget}/${splat}${qs}`;

    const method = req.method.toUpperCase();
    const hasBody = ["POST", "PUT", "PATCH"].includes(method);

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    try {
      const upstream = await fetch(targetUrl, {
        method,
        headers,
        ...(hasBody ? { body: JSON.stringify(req.body) } : {}),
      });

      const contentType = upstream.headers.get("content-type") ?? "application/json";
      res.status(upstream.status).setHeader("content-type", contentType);

      const text = await upstream.text();
      res.send(text);
    } catch (err) {
      res.status(502).json({ error: "Proxy error", detail: String(err) });
    }
  });

  export default router;
  