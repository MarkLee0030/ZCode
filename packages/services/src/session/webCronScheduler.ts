// Web/无头宿主的 cron 调度器：把桌面 scheduler 进程（desktop/src/scheduler）的
// 认领/结算循环内联到本进程运行。
//
// 桌面形态的触发侧由 Electron utilityProcess 承载；web server（entry-http）原先
// 完全没有调度实现，CronCreate 建的 automations 只能编辑、到点无人认领。本模块
// 复用同一套 AutomationRepo 事务认领（BEGIN IMMEDIATE 0→1，WAL 多进程安全），
// 与桌面 scheduler 并存也不会双派发；派发动作直接调用本进程已注册的
// IZCodeTaskService（createTask/resumeTask/sendPrompt），不经 parentPort 消息链。
//
// 相对桌面版的两处有意简化：
//   - 不做 run 终态订阅（trackCronRunOutcome）：dispatch 结算即视为派发成功，
//     run 台账停留在 dispatched，不影响 next_run_at 推进与后续触发；
//   - 不做 Bot 回推（watchCronRunBotDelivery）与 off-peak 闲时任务认领。
import {
  computeAutomationNextRunAt,
  isOneShotAutomation,
} from "./automationCron.js";
import { AutomationRepo } from "./automationRepo.js";
import { IZCodeTaskService } from "./zcodeTaskService.js";
import { formatModelPickerValue } from "../zcode-agent/zcodeConfigOptions.js";
import type { ServiceCollection } from "../collection.js";
import {
  resolveWorkspaceKey,
  type ModelSelection,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
} from "@zcode/shared";

/** 轮询间隔：cron 最小粒度是分钟，20s 轮询足以按时命中且开销低（与桌面版一致）。 */
const POLL_INTERVAL_MS = 20_000;
/** misfire 宽限：计划触发时间早于 now 超过该值视为错过窗口，跳过不补跑。 */
const MISFIRE_GRACE_MS = 5 * 60_000;

export interface WebCronSchedulerOptions {
  /** 宿主进程的服务集合；只要求能解析任务服务。 */
  services: Pick<ServiceCollection, "getOptional">;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

type InFlight = {
  automationId: string;
  workspaceKey: string;
  trigger: "schedule" | "manual";
};

/** 桌面 scheduler 的 log 经 parentPort 上报；这里直接落到宿主 logger/console。 */
function defaultLog(level: "info" | "warn" | "error", message: string): void {
  const line = `[web-cron-scheduler] ${message}`;
  if (level === "error") console.error(line);
  // eslint-disable-next-line no-console -- 无头宿主没有其他日志通道
  else console.log(line);
}

export function startWebCronScheduler(options: WebCronSchedulerOptions): {
  stop: () => Promise<void>;
  /** manual「立即运行」直发入口：manual run 落库后立即派发，不等待轮询。 */
  dispatchManualRun: (params: {
    automation: ZCodeAutomation;
    run: ZCodeAutomationRun;
  }) => Promise<void>;
} {
  const log = options.log ?? defaultLog;
  const repo = new AutomationRepo();
  const inFlight = new Map<string, InFlight>();
  // entry-http 里 services 在 createLocalServices 之后才装配；调度器先启动，
  // 装配完成后通过 attachServices 补上解析源（认领循环在首个 20s tick 前拿到即可）。
  let serviceResolver: Pick<ServiceCollection, "getOptional"> = options.services;

  let ticking = false;
  let tickRequested = false;
  let ready = false;
  let disposed = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const getTaskService = (): IZCodeTaskService | undefined =>
    serviceResolver.getOptional(IZCodeTaskService);

  function buildRunId(automationId: string, scheduledAt: number): string {
    return `${automationId}:${scheduledAt}`;
  }

  function resolveScheduledAt(automation: ZCodeAutomation, now: number): number {
    return automation.nextRunAt ?? automation.retryAt ?? now;
  }

  /**
   * 派发一次 run：创建（或恢复）目标会话并发送 prompt。
   * 已有 run 台账中的 modelSelection 是首次派发固定后的历史选择，必须优先复用。
   */
  async function dispatchCronRun(
    automation: ZCodeAutomation,
    runId: string,
    fixedSelection: ModelSelection | undefined,
  ): Promise<{ ok: true; sessionId?: string } | { ok: false; error: string }> {
    const taskService = getTaskService();
    if (!taskService) {
      return { ok: false, error: "ZCode task service is not initialized." };
    }
    const submissionSelection =
      fixedSelection ?? automation.modelSelection ??
      await repo
        .getModelSelectionForDispatch(
          automation.automationId,
          resolveWorkspaceKey({
            workspacePath: automation.workspacePath,
            workspaceIdentity: automation.workspaceIdentity,
          }),
        )
        .catch(() => undefined);
    if (submissionSelection) {
      await repo.fixRunModelSelection(runId, submissionSelection);
    }
    try {
      let taskId: string;
      if (automation.targetTaskId) {
        await taskService.resumeTask({
          taskId: automation.targetTaskId,
          workspacePath: automation.workspacePath,
          ...(automation.workspaceIdentity
            ? { workspaceIdentity: automation.workspaceIdentity }
            : {}),
          ...(submissionSelection
            ? {
                model: formatModelPickerValue(submissionSelection),
                thoughtLevel: submissionSelection.options?.reasoningLevel,
              }
            : {}),
          automationId: automation.automationId,
        });
        taskId = automation.targetTaskId;
      } else {
        const task = await taskService.createTask({
          workspacePath: automation.workspacePath,
          ...(automation.workspaceIdentity
            ? { workspaceIdentity: automation.workspaceIdentity }
            : {}),
          ...(submissionSelection ? { modelSelection: submissionSelection } : {}),
          ...(automation.mode ? { mode: automation.mode } : {}),
          automationId: automation.automationId,
        });
        taskId = task.taskId;
      }
      await taskService.sendPrompt({
        taskId,
        // 会话 trace 与执行 runId 是两种身份；派发 prompt 统一使用 runId（桌面版同款约束）。
        traceId: runId,
        content: automation.prompt,
        clientMode: "desktop-continuous",
        automationId: automation.automationId,
      });
      return { ok: true, sessionId: taskId };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** manual single-flight 锁释放：仅在派发失败（没有可等待 turn）时归还认领。 */
  async function settleManualClaimForDispatchResult(params: {
    automationId: string;
    runId: string;
    workspaceKey?: string;
    ok: boolean;
  }): Promise<void> {
    if (params.ok) return;
    const releaseWorkspaceKey =
      params.workspaceKey ??
      (await repo.getRun(params.runId).then((run) => run?.workspaceKey)) ??
      (await repo.get(params.automationId).then((automation) => automation?.workspaceKey));
    if (!releaseWorkspaceKey) {
      log(
        "error",
        `manual claim release skipped: workspaceKey missing automation=${params.automationId} runId=${params.runId}`,
      );
      return;
    }
    await repo.releaseManualClaim(params.automationId, releaseWorkspaceKey);
  }

  async function settleDispatchResult(params: {
    runId: string;
    result: { ok: true; sessionId?: string } | { ok: false; error: string };
  }): Promise<void> {
    const context = inFlight.get(params.runId);
    inFlight.delete(params.runId);
    const now = Date.now();
    const automationId = context?.automationId ?? params.runId.split(":")[0]!;
    const workspaceKey = context?.workspaceKey;
    const trigger: "schedule" | "manual" =
      context?.trigger ?? (params.runId.includes(":manual:") ? "manual" : "schedule");

    if (params.result.ok) {
      if (trigger === "manual") {
        await repo.markManualRunDispatched({
          runId: params.runId,
          sessionId: params.result.sessionId ?? null,
          dispatchedAt: now,
        });
        await settleManualClaimForDispatchResult({
          automationId,
          runId: params.runId,
          workspaceKey,
          ok: true,
        });
        return;
      }
      await repo.markRunDispatch({
        runId: params.runId,
        dispatchStatus: "dispatched",
        sessionId: params.result.sessionId ?? null,
      });
      const automation = await repo.get(automationId);
      const nextRunAt = automation ? computeAutomationNextRunAt(automation, now) : null;
      await repo.markDispatched(automationId, { dispatchedAt: now, nextRunAt });
      return;
    }

    await repo.markRunDispatch({
      runId: params.runId,
      dispatchStatus: "failed_to_dispatch",
      error: params.result.error,
    });
    if (trigger === "manual") {
      await settleManualClaimForDispatchResult({
        automationId,
        runId: params.runId,
        workspaceKey,
        ok: false,
      });
      return;
    }
    await repo.markDispatchFailed(automationId, {
      failedAt: now,
      error: params.result.error,
      kind: "transient",
      nextRunAt: await repo
        .get(automationId)
        .then((automation) => (automation ? computeAutomationNextRunAt(automation, now) : null)),
    });
  }

  async function handleClaimed(automation: ZCodeAutomation, now: number): Promise<void> {
    const scheduledAt = resolveScheduledAt(automation, now);
    const runId = buildRunId(automation.automationId, scheduledAt);
    const workspaceKey = resolveWorkspaceKey({
      workspacePath: automation.workspacePath,
      workspaceIdentity: automation.workspaceIdentity,
    });
    const isRetry = automation.dispatchAttempts > 0;

    // misfire：首轮（非重试）且计划触发时间已远早于 now → 错过窗口，跳过不补跑。
    const missed =
      !isRetry && automation.nextRunAt != null && automation.nextRunAt <= now - MISFIRE_GRACE_MS;
    if (missed) {
      // 一次性任务（如 delayMinutes 提醒）错过即终态，不得再排新的执行承诺。
      const finalize = isOneShotAutomation(automation);
      const nextRunAt = finalize ? null : computeAutomationNextRunAt(automation, now);
      await repo.skipAndReschedule({
        automationId: automation.automationId,
        runId,
        workspaceKey,
        scheduledAt,
        reason: "computer_asleep_or_app_not_running",
        nextRunAt,
        finalize,
      });
      log(
        "info",
        `skip missed window automation=${automation.automationId} scheduledAt=${scheduledAt}${finalize ? " finalized=one-shot" : ""}`,
      );
      return;
    }

    await repo.upsertRunClaimed({
      runId,
      automationId: automation.automationId,
      workspaceKey,
      scheduledAt,
      trigger: "schedule",
    });
    inFlight.set(runId, {
      automationId: automation.automationId,
      workspaceKey,
      trigger: "schedule",
    });
    const run = await repo.getRun(runId);
    const result = await dispatchCronRun(automation, runId, run?.modelSelection);
    await settleDispatchResult({ runId, result });
  }

  async function handleClaimedManual(
    automation: ZCodeAutomation,
    run: ZCodeAutomationRun,
  ): Promise<void> {
    inFlight.set(run.runId, {
      automationId: automation.automationId,
      workspaceKey: resolveWorkspaceKey({
        workspacePath: automation.workspacePath,
        workspaceIdentity: automation.workspaceIdentity,
      }),
      trigger: "manual",
    });
    const result = await dispatchCronRun(automation, run.runId, run.modelSelection);
    await settleDispatchResult({ runId: run.runId, result });
  }

  async function tick(): Promise<void> {
    if (disposed || !ready || ticking) return;
    ticking = true;
    try {
      do {
        tickRequested = false;
        try {
          const now = Date.now();
          const claimed = await repo.claimDue(now);
          for (const automation of claimed) {
            await handleClaimed(automation, now);
          }
          const manualRuns = await repo.claimManualRuns(now);
          for (const manualRun of manualRuns) {
            await handleClaimedManual(manualRun.automation, manualRun.run);
          }
        } catch (error) {
          log("error", `tick failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } while (tickRequested && !disposed);
    } finally {
      ticking = false;
    }
  }

  function requestTick(): void {
    if (disposed) return;
    if (!ready || ticking) {
      tickRequested = true;
      return;
    }
    void tick();
  }

  async function dispatchManualRun(params: {
    automation: ZCodeAutomation;
    run: ZCodeAutomationRun;
  }): Promise<void> {
    if (disposed) return;
    await handleClaimedManual(params.automation, params.run);
  }

  async function stop(): Promise<void> {
    if (disposed) return;
    disposed = true;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    // 释放仍在途的认领，避免下次启动等到 CLAIM_STALE 才回收。
    for (const [, context] of inFlight) {
      try {
        if (context.trigger === "manual") {
          await repo.releaseManualClaim(context.automationId, context.workspaceKey);
        } else {
          await repo.releaseClaim(context.automationId);
        }
      } catch {
        // 忽略：退出路径尽力而为。
      }
    }
    inFlight.clear();
    try {
      repo.close();
    } catch {
      // 忽略。
    }
  }

  void (async () => {
    try {
      await repo.ensureReady();
      ready = true;
      log("info", "web cron scheduler started");
      requestTick();
      pollTimer = setInterval(requestTick, POLL_INTERVAL_MS);
    } catch (error) {
      log(
        "error",
        `web cron scheduler bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();

  return {
    stop,
    dispatchManualRun,
    attachServices(services: Pick<ServiceCollection, "getOptional">): void {
      serviceResolver = services;
    },
  };
}
