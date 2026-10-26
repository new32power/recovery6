import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function renderPagesConfig(template, buildDirectory, bindings) {
  if (!/^name = "recovery2-robot"$/m.test(template) ||
      !/^name = "EVENT_BUS"$/m.test(template) ||
      !/^class_name = "EventBus"$/m.test(template) ||
      !/^script_name = "recovery2-robot-event-bus"$/m.test(template)) {
    throw new Error("Unexpected deployment target or EventBus binding");
  }
  if (!/^pages_build_output_dir = .+$/m.test(template) || /^\[vars\]/m.test(template)) {
    throw new Error("Unexpected Pages configuration");
  }
  const config = template.replace(/^pages_build_output_dir = .+$/m,
    `pages_build_output_dir = ${JSON.stringify(resolve(buildDirectory))}`);
  const plain = Object.entries(bindings || {}).filter(([, binding]) => binding?.type === "plain_text");
  const vars = plain.map(([key, binding]) => {
    if (typeof binding.value !== "string") throw new Error("Invalid plaintext variable");
    return `${JSON.stringify(key)} = ${JSON.stringify(binding.value)}`;
  });
  // Secrets remain server-side. Never copy secret_text values to the file/logs.
  return { config: config + (vars.length ? `\n[vars]\n${vars.join("\n")}\n` : ""), plainCount: plain.length };
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const output = process.argv[2];
  const buildDirectory = process.argv[3];
  if (!token || !account || !output || !buildDirectory) throw new Error("Deployment configuration missing");
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/pages/projects/recovery2-robot`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) },
  );
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(`Cloudflare project lookup failed (HTTP ${response.status})`);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const template = await readFile(resolve(root, "wrangler.recovery2-robot.toml"), "utf8");
  const prepared = renderPagesConfig(template, buildDirectory, body.result?.deployment_configs?.production?.env_vars);
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(output, prepared.config, { mode: 0o600 });
  console.log(`Prepared recovery2-robot Pages config with EVENT_BUS; preserved ${prepared.plainCount} plaintext variables. Secret values are not copied or logged.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
