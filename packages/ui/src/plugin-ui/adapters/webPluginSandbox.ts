import type {
  PluginSandboxHandle,
  PluginSandboxPlatformPort,
  PluginSandboxPortsEvent,
  PluginSandboxTransportPort,
} from "@zcode/shared/mcp-apps";
import { setPluginUiFrameFactory } from "./pluginUiPagePlane.js";

/**
 * Web 形态的 Gen UI 沙箱宿主端：用同源 HTTP 路由 + sandboxed <iframe> 等价桌面的
 * Electron 沙箱链。guest 侧运行时与桌面同一份 gen-ui.js（经 server 路由下发），其
 * 官方 ext-apps `App` 以 postMessage JSON-RPC 直连 window.parent——本模块把该通道
 * 适配成共享管线期待的 `PluginSandboxTransportPort`，再经 `onPorts` 交给
 * `createPluginUiMessagePortTransport`。桌面链路里的受信 relay shell 在 web 上是多余
 * 的一跳（iframe 的 parent 就是应用窗口），因此不再单独引入。
 *
 * 隔离边界与桌面同构：iframe `sandbox="allow-scripts allow-forms"`（不带
 * allow-same-origin → guest 拿到不透明 origin，无 storage / 无同源权限），文档 CSP
 * 由 server 路由下发；postMessage 只透传 JSON-RPC 帧，其余消息丢弃。
 */

interface SandboxEntry {
  iframe: HTMLIFrameElement;
  initId: number;
  port: PluginSandboxTransportPort;
}

export type WebPluginSandbox = PluginSandboxPlatformPort & {
  /** plane.mount 的 frame 工厂；注入 setPluginUiFrameFactory 由本函数完成。 */
  createFrame(handle: PluginSandboxHandle): HTMLIFrameElement;
  stop(): void;
};

/** web 没有 Electron webContentsId；owner 只作为不透明 token 贯穿登记，正整数即可。 */
const WEB_OWNER_WEB_CONTENTS_ID = 1;

export function createWebPluginSandbox(): WebPluginSandbox {
  const entries = new Map<string, SandboxEntry>();
  const portsHandlers = new Set<(event: PluginSandboxPortsEvent) => void>();

  const onWindowMessage = (event: MessageEvent) => {
    if (event.source === window) return;
    // 只处理已登记 iframe 的 JSON-RPC 帧；透传其余消息会让共享 transport 直接报错。
    const data = event.data as { jsonrpc?: unknown } | null;
    if (!data || typeof data !== "object" || data.jsonrpc !== "2.0") return;
    for (const entry of entries.values()) {
      if (event.source === entry.iframe.contentWindow) {
        entry.port.onmessage?.({ data: event.data });
        return;
      }
    }
  };
  window.addEventListener("message", onWindowMessage);

  const createFrame = (handle: PluginSandboxHandle): HTMLIFrameElement => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts allow-forms");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.setAttribute("allow", "");
    iframe.setAttribute("data-testid", "plugin-ui-iframe");
    iframe.title = "Gen UI";
    iframe.src = new URL(handle.shellUrl, window.location.href).toString();
    iframe.style.cssText =
      "display:block;width:100%;height:100%;border:0;background:transparent;pointer-events:auto";
    // plane.move 的迁移门：moveBefore 存在时迁移不触发 iframe 重载（Chromium 133+）。
    if (typeof (HTMLElement.prototype as { moveBefore?: unknown }).moveBefore === "function") {
      (iframe as HTMLElement & { connectedMoveCallback?: unknown }).connectedMoveCallback = () => {};
    }
    const port: PluginSandboxTransportPort = {
      onmessage: null,
      postMessage: (message) => {
        iframe.contentWindow?.postMessage(message, "*");
      },
      start() {},
      close() {
        port.onmessage = null;
      },
    };
    entries.set(handle.sandboxId, { iframe, initId: handle.initId, port });
    // 与桌面 attachGuest 后端口就绪同序：mount 即发 port，guest 连接是懒触发的。
    for (const handler of portsHandlers)
      handler({ sandboxId: handle.sandboxId, initId: handle.initId, port });
    return iframe;
  };

  setPluginUiFrameFactory((handle) => createFrame(handle));

  return {
    supportsRetainedMove:
      typeof (HTMLElement.prototype as { moveBefore?: unknown }).moveBefore === "function",
    createFrame,
    async getOwnerWebContentsId() {
      return WEB_OWNER_WEB_CONTENTS_ID;
    },
    async disposeSandbox(sandboxId, initId) {
      const entry = entries.get(sandboxId);
      if (!entry) return;
      if (initId !== undefined && entry.initId !== initId) return;
      entries.delete(sandboxId);
      entry.port.onmessage = null;
      entry.iframe.remove();
    },
    async consumeUserGesture() {
      // iframe 内的指针/键盘事件不冒泡到父文档，宿主侧无法观察真实手势；guest 侧
      // window.zcode.openExternal 等入口自带 navigator.userActivation 检查，这里放行。
      return true;
    },
    onPorts(handler) {
      portsHandlers.add(handler);
      return () => {
        portsHandlers.delete(handler);
      };
    },
    stop() {
      window.removeEventListener("message", onWindowMessage);
      portsHandlers.clear();
      for (const entry of entries.values()) entry.iframe.remove();
      entries.clear();
      setPluginUiFrameFactory(null);
    },
  };
}
