import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWebGenUiSandboxHost,
  type WebGenUiSandboxHost,
} from "../src/genUiWebSandbox.js";

function genUiInput(overrides: Partial<Parameters<WebGenUiSandboxHost["register"]>[0]> = {}) {
  return {
    contentKind: "gen-ui" as const,
    instance: { runtimeId: "rt", generation: 1, appIdentity: "a".repeat(64), token: "t" },
    ownerWebContentsId: 1,
    sessionId: "s1",
    scopeId: "scope-1",
    html:
      '<!doctype html><html><head><meta charset="utf-8"><!--__ZCODE_GEN_UI_STYLES__--><script type="application/json" id="zcode-gen-ui-initial-state">null</script><script src="__ZCODE_GEN_UI_RUNTIME__"></script></head><body><p>fragment</p><!--__ZCODE_GEN_UI_INNER_KIT__--></body></html>',
    csp: {
      connectDomains: [],
      resourceDomains: ["https://esm.sh"],
      frameDomains: [],
      baseUriDomains: [],
    },
    ...overrides,
  };
}

describe("createWebGenUiSandboxHost", () => {
  const tempDirs: string[] = [];
  let hosts: WebGenUiSandboxHost[] = [];

  afterEach(async () => {
    for (const host of hosts.splice(0)) host.stop();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createHost(maxEntries?: number) {
    const assetsDir = await mkdtemp(join(tmpdir(), "gen-ui-assets-"));
    tempDirs.push(assetsDir);
    await writeFile(join(assetsDir, "visualize.css"), ".viz{color:red}");
    await writeFile(
      join(assetsDir, "visualize.html"),
      "<div>kit<!--__INLINE_VISUALIZATION_FRAGMENT__--></div>",
    );
    await writeFile(join(assetsDir, "gen-ui.js"), "console.log('runtime')");
    const host = createWebGenUiSandboxHost({
      assetsDir,
      ...(maxEntries !== undefined ? { maxEntries } : {}),
    });
    hosts.push(host);
    return host;
  }

  it("登记 gen-ui 沙箱并按占位符替换服务完整文档", async () => {
    const host = await createHost();
    const handle = host.register(genUiInput());
    expect(handle.sandboxId).toMatch(/^sb-[0-9a-f]+$/);
    expect(handle.initId).toBe(1);
    expect(handle.shellUrl).toBe(`/api/plugin-sandbox/${handle.sandboxId}/index.html`);

    const doc = await host.serveDocument(handle.sandboxId);
    expect(doc).not.toBeNull();
    expect(doc!.html).toContain(`/api/plugin-sandbox/${handle.sandboxId}/__zcode__/gen-ui.js`);
    expect(doc!.html).toContain(".viz{color:red}");
    expect(doc!.html).toContain("<div>kit</div>");
    expect(doc!.html).not.toContain("__ZCODE_GEN_UI_INNER_KIT__");
    expect(doc!.cspHeader).toContain("https://esm.sh");
    expect(doc!.cspHeader).toContain("frame-ancestors 'self'");
    expect(doc!.cspHeader).toContain("connect-src 'none'");
  });

  it("runtime 文件仅对已登记沙箱放行并拒绝路径穿越", async () => {
    const host = await createHost();
    const handle = host.register(genUiInput());
    const runtime = await host.serveRuntimeFile(handle.sandboxId, "gen-ui.js");
    expect(runtime?.body).toBe("console.log('runtime')");
    expect(runtime?.contentType).toContain("text/javascript");

    expect(await host.serveRuntimeFile(handle.sandboxId, "../package.json")).toBeNull();
    expect(await host.serveRuntimeFile("sb-unknown", "gen-ui.js")).toBeNull();
    expect(await host.serveDocument("sb-unknown")).toBeNull();
  });

  it("dispose 按 initId 匹配；错误代次不误杀新登记", async () => {
    const host = await createHost();
    const handle = host.register(genUiInput());
    host.dispose(handle.sandboxId, 2);
    expect(await host.serveDocument(handle.sandboxId)).not.toBeNull();
    host.dispose(handle.sandboxId, 1);
    expect(await host.serveDocument(handle.sandboxId)).toBeNull();
  });

  it("容量超限时登记报错", async () => {
    const host = await createHost(2);
    host.register(genUiInput());
    host.register(genUiInput({ scopeId: "scope-2" }));
    expect(() => host.register(genUiInput({ scopeId: "scope-3" }))).toThrow(/quota/i);
  });

  it("拒绝非 Gen UI 的 MCP 插件登记与越权 Gen UI 能力", () => {
    const host = createWebGenUiSandboxHost({ assetsDir: tmpdir() });
    hosts.push(host);
    expect(() =>
      host.register(genUiInput({ contentKind: undefined, pluginId: "p", serverName: "s" }) as never),
    ).toThrow(/not supported on web/);
    expect(() =>
      host.register(genUiInput({ pluginId: "p", serverName: "s" }) as never),
    ).toThrow(/Invalid Gen UI capabilities/);
  });
});
