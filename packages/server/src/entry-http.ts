import { createLocalServices, getAppConfigDir, startWebCronScheduler } from "@zcode/services/node";
import {
  materializeBundledZCodeBuiltinProviderConfig,
  readBundledZCodeBuiltinProviderConfig,
} from "./bundledZCodeBuiltinProviderConfig.js";
import { createHttpServer } from "./http.js";

async function main(): Promise<void> {
  const zcodeBuiltinProviderConfigFilePath = await materializeBundledZCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledZCodeBuiltinProviderConfig(),
  });
  const port = Number(process.env["PORT"]) || 3030;
  const host = process.env["ZCODE_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() || undefined;
  const staticRoot = process.env["ZCODE_WEB_STATIC_ROOT"]?.trim() || undefined;
  const authToken = process.env["ZCODE_SERVER_AUTH_TOKEN"]?.trim() || undefined;
  // Web 形态此前没有 cron 触发侧（桌面由 Electron utilityProcess scheduler 承载），
  // automations 只能建不能跑。调度循环在本进程内补上触发；manual「立即运行」的
  // 直发钩子经闭路引用注入（hook 只会来自启动后的 RPC，届时 scheduler 必已赋值）。
  let webCronScheduler: ReturnType<typeof startWebCronScheduler> | undefined;
  const services = createLocalServices({
    zcodeBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: Boolean(authToken),
    onAutomationManualRunRequested: (params) => webCronScheduler?.dispatchManualRun(params),
  });
  // 必须在 createLocalServices 之后启动：services 装配失败时进程能自然退出，
  // 而不是留下一个只剩调度循环的不死进程反复派发失败。
  webCronScheduler = startWebCronScheduler({ services });

  createHttpServer(services, port, {
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
  });

  // 注册了信号处理器会抑制 Node 默认退出，而 HTTP server 持续占用事件循环；
  // 这里必须主动收尾退出，否则 Ctrl+C / docker stop 后进程变孤儿。
  const shutdown = () => {
    void webCronScheduler?.stop().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void main().catch((error: unknown) => {
  console.error("[zcode-server:http] startup failed", error);
  process.exitCode = 1;
});
