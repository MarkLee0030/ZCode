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
  // automations 只能建不能跑。这里在本进程内启动调度循环补上触发；manual「立即运行」
  // 的直发钩子同步注入，否则 runAutomationNow 会抛 dispatcher unavailable。
  const webCronScheduler = startWebCronScheduler({
    services: { getOptional: () => undefined },
  });
  const services = createLocalServices({
    zcodeBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: Boolean(authToken),
    onAutomationManualRunRequested: (params) => webCronScheduler.dispatchManualRun(params),
  });
  // 调度器创建时 services 尚未装配；拿到实例后再补上任务服务解析。
  webCronScheduler.attachServices(services);

  createHttpServer(services, port, {
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
  });

  const shutdown = () => {
    void webCronScheduler.stop();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void main().catch((error: unknown) => {
  console.error("[zcode-server:http] startup failed", error);
  process.exitCode = 1;
});
