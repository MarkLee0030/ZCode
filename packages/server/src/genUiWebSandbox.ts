import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";
import type {
  McpToolUiCsp,
  PluginSandboxHandle,
  PluginSandboxRegisterInput,
} from "@zcode/shared/mcp-apps";
import { normalizeCspOrigin } from "@zcode/shared/mcp-apps";

/**
 * Web 形态的 Gen UI 沙箱宿主。
 *
 * 桌面形态由 Electron main 的自定义 `zcode-sandbox://` 协议承载沙箱文档与 CSP；web 形态
 * 没有自定义协议，改为 server 内存登记 + 同源 HTTP 路由（`/api/plugin-sandbox/...`，随
 * `/api/*` 一并落入 token 鉴权）。guest 运行时（gen-ui.js）、visualize 套件、CSP 策略与
 * 桌面逐项对齐；差异只有三点，均为 web 环境约束而非能力裁剪：
 *   - frame-ancestors 从 shell 自定义协议 origin 改为 'self'（本站页面才能内嵌）；
 *   - vendor CDN 重定向不做：桌面经协议层把白名单 CDN URL 换成本地文件，web iframe 无法
 *     拦截跨源 URL，白名单域在 CSP 里直接放行，离线场景退化为资源加载失败；
 *   - registry 无 guest 存活信号，TTL 按最近访问时间计算（桌面按无活跃 guest）。
 */

/** 与桌面 createPluginSandboxRegistry 的默认值对齐。 */
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 64;
const SANDBOX_ID_PATTERN = /^[A-Za-z0-9-]+$/;

interface SandboxRecord {
  sandboxId: string;
  initId: number;
  html: string;
  cspHeader: string;
  lastAccessAt: number;
}

export interface WebGenUiSandboxHost {
  /** createLocalServices 的 registerPluginSandbox 插槽实现。 */
  register(input: PluginSandboxRegisterInput): PluginSandboxHandle;
  dispose(sandboxId: string, initId?: number): void;
  /** 服务沙箱文档（占位符替换后的完整 HTML）。未登记或已过期返回 null。 */
  serveDocument(sandboxId: string): Promise<{ html: string; cspHeader: string } | null>;
  /** 服务 guest 运行时静态文件（gen-ui.js）。 */
  serveRuntimeFile(
    sandboxId: string,
    file: string,
  ): Promise<{ body: string; contentType: string } | null>;
  stop(): void;
}

function normalizeOrigins(list: string[] | undefined): string[] {
  if (!list) return [];
  return [
    ...new Set(
      list.map(normalizeCspOrigin).filter((origin): origin is string => origin !== null),
    ),
  ];
}

function buildWebGenUiCsp(csp: McpToolUiCsp | undefined): string {
  const resource = normalizeOrigins(csp?.resourceDomains);
  const scriptSources = ["'self'", "'unsafe-inline'", "blob:", "data:", ...resource];
  return [
    "default-src 'none'",
    `script-src ${scriptSources.join(" ")}`,
    `style-src ${["'self'", "'unsafe-inline'", ...resource].join(" ")}`,
    `img-src ${["'self'", "data:", "blob:", ...resource].join(" ")}`,
    `media-src ${["'self'", "data:", "blob:", ...resource].join(" ")}`,
    `font-src ${["'self'", "data:", ...resource].join(" ")}`,
    // Gen UI guest 的 csp.connectDomains 恒为空（见 services createGenUiService），
    // postMessage 通道不受 connect-src 影响。
    "connect-src 'none'",
    "frame-src 'none'",
    "base-uri 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "form-action 'none'",
  ].join("; ");
}

/** 与桌面 buildPluginSandboxPermissionsPolicy(undefined, "plugin") 一致：未声明一律拒绝。 */
const PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "display-capture=()",
  "payment=()",
  "usb=()",
  "clipboard-read=()",
].join(", ");

export const WEB_GEN_UI_PERMISSIONS_POLICY = PERMISSIONS_POLICY;

export function createWebGenUiSandboxHost(options: {
  assetsDir: string;
  ttlMs?: number;
  maxEntries?: number;
  log?: (message: string, detail?: unknown) => void;
}): WebGenUiSandboxHost {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries = new Map<string, SandboxRecord>();
  const runtimeCache = new Map<string, string>();
  const assetsDir = resolve(options.assetsDir);

  const readAsset = async (relativePath: string): Promise<string> => {
    const cached = runtimeCache.get(relativePath);
    if (cached !== undefined) return cached;
    // 防路径穿越：规范化后必须仍在 assetsDir 内（与桌面 serveAsset 同规则）。
    const absolute = normalize(join(assetsDir, relativePath));
    const root = normalize(join(assetsDir, sep));
    if (!absolute.startsWith(root)) throw new Error("Gen UI asset escapes the assets directory");
    const body = await readFile(absolute, "utf8");
    runtimeCache.set(relativePath, body);
    return body;
  };

  const pruneExpired = (now: number) => {
    for (const [sandboxId, record] of entries)
      if (now - record.lastAccessAt > ttlMs) entries.delete(sandboxId);
  };

  const pruneTimer = setInterval(() => pruneExpired(Date.now()), 5 * 60 * 1000);
  pruneTimer.unref?.();

  return {
    register(input) {
      // MCP 插件沙箱（MCP Apps 工具卡片/面板）在 web 上还没有宿主实现；Gen UI 才走本路径。
      if (input.contentKind !== "gen-ui")
        throw new Error("MCP plugin sandboxes are not supported on web yet");
      // 与桌面 registry 同规：Gen UI 不携带 MCP 溯源与浏览器权限。
      if (input.pluginId || input.serverName || input.permissions?.length)
        throw new Error("Invalid Gen UI capabilities");
      pruneExpired(Date.now());
      if (entries.size >= maxEntries) {
        throw new Error(
          `Gen UI sandbox quota exceeded (${maxEntries}); close unused visualization cards and retry`,
        );
      }
      const sandboxId = `sb-${randomUUID().replaceAll("-", "")}`;
      if (!SANDBOX_ID_PATTERN.test(sandboxId)) throw new Error("Generated sandbox id is invalid");
      entries.set(sandboxId, {
        sandboxId,
        initId: 1,
        html: input.html,
        cspHeader: buildWebGenUiCsp(input.csp),
        lastAccessAt: Date.now(),
      });
      options.log?.("[gen-ui-web-sandbox] registered", { sandboxId, scopeId: input.scopeId });
      return {
        instance: input.instance,
        sandboxId,
        initId: 1,
        shellUrl: `/api/plugin-sandbox/${sandboxId}/index.html`,
        // web iframe 没有持久 partition；句柄字段保留以对齐共享类型。
        partition: `gen-ui-web-${sandboxId}`,
      };
    },
    dispose(sandboxId, initId) {
      const record = entries.get(sandboxId);
      if (!record) return;
      if (initId !== undefined && record.initId !== initId) return;
      entries.delete(sandboxId);
    },
    async serveDocument(sandboxId) {
      const record = entries.get(sandboxId);
      if (!record) return null;
      record.lastAccessAt = Date.now();
      let html = record.html.replace(
        "__ZCODE_GEN_UI_RUNTIME__",
        `/api/plugin-sandbox/${sandboxId}/__zcode__/gen-ui.js`,
      );
      try {
        const [styles, kit] = await Promise.all([
          readAsset("visualize.css"),
          readAsset("visualize.html"),
        ]);
        html = html.replace(
          "<!--__ZCODE_GEN_UI_STYLES__-->",
          `<style>${styles}\n:root { --visualize-paint-gutter: 5px; --viz-fg: var(--foreground); }</style>`,
        );
        if (/\bviz-calendar\b/i.test(record.html)) {
          const calendar = await readAsset("calendar.js");
          html = html.replace(
            "</head>",
            `<script>${calendar.replaceAll("</script", "<\\/script")}</script></head>`,
          );
        }
        const marker = "<!--__ZCODE_GEN_UI_INNER_KIT__-->";
        const index = html.lastIndexOf(marker);
        if (index < 0) throw new Error("Gen UI document is missing its runtime slot");
        html =
          html.slice(0, index) +
          kit.replace("<!--__INLINE_VISUALIZATION_FRAGMENT__-->", "") +
          '<style id="zcode-gen-ui-document-scrollbar">html,body{scrollbar-width:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important}</style>' +
          html.slice(index + marker.length);
      } catch (error) {
        // 与桌面一致：资源缺失不返回半成品文档，避免页面看似加载成功但交互静默失效。
        options.log?.(
          "[gen-ui-web-sandbox] runtime resources unavailable",
          error instanceof Error ? error.message : String(error),
        );
        return null;
      }
      return { html, cspHeader: record.cspHeader };
    },
    async serveRuntimeFile(sandboxId, file) {
      // runtime 文件只对已登记沙箱放行：文档 404 的沙箱不应留下可猜的静态入口。
      const record = entries.get(sandboxId);
      if (!record) return null;
      record.lastAccessAt = Date.now();
      if (!/^[a-z0-9][a-z0-9.-]*\.(js|css|html)$/.test(file)) return null;
      const body = await readAsset(file);
      return {
        body,
        contentType: file.endsWith(".css")
          ? "text/css; charset=utf-8"
          : file.endsWith(".html")
            ? "text/html; charset=utf-8"
            : "text/javascript; charset=utf-8",
      };
    },
    stop() {
      clearInterval(pruneTimer);
      entries.clear();
    },
  };
}
