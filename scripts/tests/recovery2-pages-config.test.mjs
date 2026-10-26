import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { renderPagesConfig } from "../src/prepare-recovery2-pages-config.mjs";
import test from "node:test";

const template = await readFile(new URL("../../wrangler.recovery2-robot.toml", import.meta.url), "utf8");
test("retains Pages marker and cross-Worker Durable Object binding", () => {
  const { config } = renderPagesConfig(template, "/synthetic/build/public", {});
  assert.match(config, /^pages_build_output_dir = "\/synthetic\/build\/public"$/m);
  assert.match(config, /^script_name = "recovery2-robot-event-bus"$/m);
  assert.match(config, /^class_name = "EventBus"$/m);
});
test("preserves existing plaintext variables without copying secrets", () => {
  const { config, plainCount } = renderPagesConfig(template, "/synthetic/build/public", {
    EXISTING_VAR: { type: "plain_text", value: 'synthetic\n"value"' },
    EXISTING_SECRET: { type: "secret_text", value: "never-copy-this-synthetic-secret" },
  });
  assert.equal(plainCount, 1);
  assert.ok(config.includes('"EXISTING_VAR" = "synthetic\\n\\"value\\""'));
  assert.doesNotMatch(config, /EXISTING_SECRET|never-copy-this/);
});
test("refuses a different Pages/Worker target or missing Pages marker", () => {
  assert.throws(() => renderPagesConfig(template.replace('name = "recovery2-robot"', 'name = "other-project"'), "/synthetic", {}));
  assert.throws(() => renderPagesConfig(template.replace('script_name = "recovery2-robot-event-bus"', 'script_name = "other-bus"'), "/synthetic", {}));
  assert.throws(() => renderPagesConfig(template.replace(/^pages_build_output_dir = .+\n/m, ""), "/synthetic", {}));
});
test("deployment workflow uses recognized config and checks actual realtime", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/deploy-recovery2-robot.yml", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /sed -i.*pages_build_output_dir/);
  assert.match(workflow, /prepare-recovery2-pages-config\.mjs/);
  assert.match(workflow, /--project-name=recovery2-robot --branch=main/);
  assert.match(workflow, /new WebSocket\("wss:\/\/recovery2-robot\.pages\.dev\/api\/events"\)/);
  assert.match(workflow, /message\.event !== "ping"/);
});
