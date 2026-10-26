import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";
import test from "node:test";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appPath = resolve(dashboard, "src/App.tsx");
const loginPagePath = resolve(dashboard, "src/pages/WebDashboard.tsx");

test("master generates registered, encoded canonical subadmin links", async () => {
  const source = await readFile(resolve(dashboard, "src/pages/MainAdminPanel.tsx"), "utf8");
  assert.doesNotMatch(source, /\/preview\/dashboard\/WebDashboard\?appId=/);
  assert.equal((source.match(/\/login\/\$\{encodeURIComponent\(app\.appId\)\}\?pt=\$\{encodeURIComponent\(/g) || []).length, 2);
});

test("sub-admin login uses the real PIN directly and creates the matching session", async () => {
  const source = await readFile(loginPagePath, "utf8");
  assert.doesNotMatch(source, /__check__/);
  assert.match(source, /body:\s*JSON\.stringify\(\{\s*pin,\s*panelToken\s*\}\)/);
  assert.match(source, /body:\s*JSON\.stringify\(\{\s*appId,\s*pin,\s*panelToken,\s*deviceId:\s*getDeviceId\(\)\s*\}\)/);
  assert.match(source, /get\("pt"\)/);
});

for (const [label, path, search, expected] of [
  ["legacy copied link", "/preview/dashboard/WebDashboard", "?appId=SYNTHETIC-LEGACY&pt=synthetic-token", "SYNTHETIC-LEGACY"],
  ["canonical path wins over query", "/login/SYNTHETIC-PATH", "?appId=DIFFERENT&pt=synthetic-token", "SYNTHETIC-PATH"],
]) {
  test(`${label} renders the actual login route with correct app ID`, async () => {
    const temp = await mkdtemp(join(tmpdir(), "recovery2-routes-"));
    try {
      const outfile = join(temp, "render.cjs");
      await build({
        stdin: {
          contents: `import App from ${JSON.stringify(appPath)};
            import { createElement } from "react";
            import { Router } from "wouter";
            import { renderToStaticMarkup } from "react-dom/server";
            globalThis.window = {location:{search:${JSON.stringify(search)}}, matchMedia:()=>({matches:false})};
            globalThis.sessionStorage = {getItem:()=>null};
            globalThis.localStorage = {getItem:()=>null};
            module.exports = renderToStaticMarkup(createElement(Router, {ssrPath:${JSON.stringify(path)}}, createElement(App)));`,
          resolveDir: dashboard,
        },
        plugins: [{
          name: "resolve-project-aliases",
          setup(builder) {
            builder.onResolve({ filter: /^@\/pages\// }, args => ({ path: resolve(dashboard, "src", args.path.slice(2) + ".tsx") }));
            builder.onResolve({ filter: /^@\/components\// }, args => ({ path: args.path, namespace: "test-ui" }));
            builder.onLoad({ filter: /.*/, namespace: "test-ui" }, () => ({
              contents: "export const CircularLoader=()=>null, CopyIconButton=()=>null, DeleteIconButton=()=>null, TopProgressBar=()=>null;",
              loader: "js",
            }));
          },
        }],
        define: { "import.meta.env.BASE_URL": '"/"' },
        bundle: true, platform: "node", format: "cjs", jsx: "automatic", outfile, logLevel: "silent",
      });
      const html = createRequire(import.meta.url)(outfile);
      assert.match(html, /Token ID/);
      assert.match(html, /PIN/);
      assert.ok(html.includes(`value="${expected}"`));
      assert.doesNotMatch(html, /Page not found/);
      assert.match(html, /type="password"/); // The access link still requires the sub-admin PIN.
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
}
