import { existsSync, readFileSync } from "fs";
  import { resolve } from "path";

  function loadEnvFile(): void {
    const candidates = [
      resolve(process.cwd(), ".env"),
      resolve(process.cwd(), "..", ".env"),
      resolve(process.cwd(), "..", "..", ".env"),
    ];

    const envFile = candidates.find((file) => existsSync(file));
    if (!envFile) return;

    const lines = readFileSync(envFile, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      value = value.replace(/\\n/g, "\n");
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }

  loadEnvFile();

  export const env = {
    port: Number(process.env.PORT ?? 5000),
    nodeEnv: process.env.NODE_ENV ?? "production",
    appSecret: process.env.APP_SECRET ?? "",
    proxyTarget: process.env.PROXY_TARGET ?? "https://mr-robot-5s3.pages.dev/api",
  };
  