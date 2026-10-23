import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const outDir = resolve(repoRoot, "packages/server/gen-ui-assets");
const desktopGuestEntry = resolve(
  repoRoot,
  "packages/desktop/src/renderer/src/plugin-sandbox/genUi.ts",
);
const runtimeAssetsSource = resolve(
  repoRoot,
  "apps/zcode-cli/packages/visualize-plugin/skills/visualize/assets",
);

/**
 * Web 形态的 Gen UI guest 运行时资产：
 *  1. gen-ui.js —— 与桌面完全同一份 guest 入口（packages/desktop/src/renderer/src/plugin-sandbox/genUi.ts）
 *     打成浏览器 IIFE；该文件只依赖官方 ext-apps SDK / zod / @zcode/shared(gen-ui)，无 Electron 依赖，
 *     web iframe 与桌面沙箱页行为因此同源（上游移动该文件时这里会在构建期报错，属预期防漂移）。
 *  2. visualize.css / visualize.html / calendar.js / vendor —— 与桌面 copyGenUiRuntimeAssets 同一份
 *     源（apps/zcode-cli/packages/visualize-plugin），vendor 清单带 sha256 校验。
 */
export async function buildGenUiAssets(destination = outDir) {
  await mkdir(destination, { recursive: true });

  await build({
    entryPoints: [desktopGuestEntry],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile: join(destination, "gen-ui.js"),
    // 沙箱页面没有 node_modules：SDK 与 zod 必须全部打进 IIFE（与桌面 tsup 配置一致）。
    packages: "bundle",
    legalComments: "none",
    logLevel: "info",
  });

  const manifest = JSON.parse(
    await readFile(join(runtimeAssetsSource, "vendor/manifest.json"), "utf8"),
  );
  const vendorFiles = new Map();
  for (const resource of manifest.resources) {
    vendorFiles.set(resource.file, resource.sha256);
    if (resource.licenseFile) vendorFiles.set(resource.licenseFile, resource.licenseSha256);
  }
  await Promise.all(
    [...vendorFiles].map(async ([file, expectedHash]) => {
      if (!/^[a-zA-Z0-9.-]+$/.test(file)) throw new Error(`Invalid Gen UI vendor file: ${file}`);
      const bytes = await readFile(join(runtimeAssetsSource, `vendor/${file}`));
      if (createHash("sha256").update(bytes).digest("hex") !== expectedHash)
        throw new Error(`Gen UI vendor hash mismatch: ${file}`);
    }),
  );
  await mkdir(join(destination, "vendor"), { recursive: true });
  await Promise.all(
    [
      "visualize.css",
      "visualize.html",
      "calendar.js",
      "vendor/manifest.json",
      ...[...vendorFiles.keys()].map((file) => `vendor/${file}`),
    ].map((file) => copyFile(join(runtimeAssetsSource, file), join(destination, file))),
  );
}

// 直接执行时（predev/prebuild 钩子）立即构建；作为模块导出供测试复用。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildGenUiAssets().catch((error) => {
    console.error("[build-gen-ui-assets] failed", error);
    process.exit(1);
  });
}
