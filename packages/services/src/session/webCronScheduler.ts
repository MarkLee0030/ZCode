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

  let ticking = false;
  let tickRequested = false;
  let ready = false;
  let disposed = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const getTaskService = (): IZCodeTaskService | undefined =>
    options.services.getOptional(IZCodeTaskService);

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
    try {
      // 模型解析在 try 内：getRepo 抛错（如配置损坏）转成 ok:false 走 transient
      // 重试，不能炸掉整个 tick 循环连累同批已认领任务。
      const submissionSelection =
        fixedSelection ?? automation.modelSelection ??
        await repo.getModelSelectionForDispatch(
          automation.automationId,
          resolveWorkspaceKey({
            workspacePath: automation.workspacePath,
            workspaceIdentity: automation.workspaceIdentity,
          }),
        );
      if (submissionSelection) {
        await repo.fixRunModelSelection(runId, submissionSelection);
      }
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
        // 桌面版靠 turn 终态订阅 + 心跳释放 manual 锁；web 版没有终态回执，
        // 若沿用「成功不释放」会把锁占满 CLAIM_STALE_MS(10min)，期间挡住
        // scheduled 认领并让紧跟的触发落入 misfire。这里在派发成功后立即
        // 归还认领，代价是失去「manual turn 进行中防重复点按」保护（初版
        // 可接受：与 scheduled 双实例并存的既有风险同级）。
        const manualWorkspaceKey =
          workspaceKey ??
          (await repo.getRun(params.runId).then((run) => run?.workspaceKey)) ??
          (await repo.get(automationId).then((automation) => automation?.workspaceKey));
        if (manualWorkspaceKey) {
          await repo.releaseManualClaim(automationId, manualWorkspaceKey);
        }
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
  ): Promise<{ ok: true; sessionId?: string } | { ok: false; error: string }> {
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
    return result;
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
            // per-item 隔离：单个 automation 的派发/结算异常不能连累同批
            // 已认领的其他任务（认领后 10 分钟无人结算会被 stale 回收并
            // 大概率落入 misfire-skip，等于丢一整批触发）。
            try {
              await handleClaimed(automation, now);
            } catch (error) {
              log(
                "error",
                `handleClaimed failed automation=${automation.automationId}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          const manualRuns = await repo.claimManualRuns(now);
          for (const manualRun of manualRuns) {
            try {
              await handleClaimedManual(manualRun.automation, manualRun.run);
            } catch (error) {
              log(
                "error",
                `handleClaimedManual failed automation=${manualRun.automation.automationId}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
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
    // 派发失败必须向调用方抛错（对齐桌面直发路径的 rethrow），否则
    // runAutomationNow 静默返回 queued，用户误以为已触发。
    const result = await handleClaimedManual(params.automation, params.run);
    if (!result.ok) {
      throw new Error(result.error);
    }
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

  return { stop, dispatchManualRun };
}
