/**
 * 桌宠「干活模式」：把一句任务交给一个真正的 DSH agent 会话（带工具、带工作区），
 * 等这一轮结束后把最终的助手正文拿回来。
 *
 * 与 `chat.ts` 的单次 LLM 调用不同，这里走宿主的 `sessionController`：工具调用、
 * 审批、工作区读写都由 DSH 自己完成。桌宠没有审批界面，所以干活会话会被设成
 * 「完全访问」——这是这个功能的前提，调用方必须在文档里写清楚。
 *
 * 模块不读写配置、不碰记忆、不写气泡：它只负责「跑一轮，拿文本」。
 *
 * @module dsh-pet/src/host/pet-work
 */

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 干活会话 id 前缀；每个宠物一条，跨请求复用同一条会话。 */
export const PET_WORK_SESSION_PREFIX = 'pet-work-';

/** 默认单轮上限：20 分钟。超过就中止，别让一只宠物把会话占一整天。 */
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

/** 至少给 60 秒，防止调用方传 0 把任务立刻掐掉。 */
const MIN_TIMEOUT_MS = 60_000;

/** 气泡正文上限：超出只截断展示，完整正文仍写进对话记忆。 */
export const PET_WORK_BUBBLE_LIMIT = 4000;

/** 日志口子：与宿主 `ctx.logger` 同形，但只要求这三个方法。 */
export interface PetWorkLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** 宿主上下文里本模块用到的部分；全部可选，缺服务时给结构化失败而不是崩。 */
export interface PetWorkHost {
  get?: (name: string, required?: boolean) => unknown;
  on?: (event: string, listener: (payload: unknown) => void) => (() => void) | undefined;
}

/** 一次干活请求。 */
export interface PetWorkInput {
  /** 宿主上下文（apply 收到的那一个）。 */
  readonly ctx: PetWorkHost;
  /** 宿主日志。 */
  readonly log: PetWorkLogger;
  /** 哪只宠物发起的；同时决定会话 id。 */
  readonly petId: string;
  /** 任务正文（已经去掉触发前缀）。 */
  readonly text: string;
  /** 覆盖默认超时（毫秒）。 */
  readonly timeoutMs?: number;
}

/** 干活结果：成功带回助手正文；失败带回一句人话。 */
export type PetWorkResult = { ok: true; text: string } | { ok: false; message: string };

/** 正在干活的宠物 id：同一只宠物同时只跑一件，避免两条 agent 轮次互相插队。 */
const running = new Set<string>();

/**
 * 这只宠物是不是正在干活。
 *
 * @param petId - 宠物 id。
 * @returns 有未结束的轮次时为 true。
 */
export function isPetWorking(petId: string): boolean {
  return running.has(petId);
}

/** 会话 id 只留安全字符：宠物 id 来自配置，不能直接拼进会话文件名。 */
function sessionIdFor(petId: string): string {
  const safe = petId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
  return PET_WORK_SESSION_PREFIX + (safe === '' ? 'main' : safe);
}

/** 从 `agent/assistant-stream` 的帧里取本会话的可见文本与结束信号。 */
function readFrame(payload: unknown, sessionId: string): { text?: string; ended?: boolean } {
  const root = payload as { agent?: { session?: { id?: unknown } }; frame?: { type?: unknown; chunk?: unknown } };
  if (root?.agent?.session?.id !== sessionId) return {};
  if (root.frame?.type === 'end') return { ended: true };
  const chunk = root.frame?.chunk as { type?: unknown; text?: unknown } | undefined;
  if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') return { text: chunk.text };
  return {};
}

/** 把会话设成完全访问：桌宠没有审批界面，不设就会卡在审批上直到超时。 */
function applyFullAccess(ctx: PetWorkHost, sessionId: string, log: PetWorkLogger): void {
  try {
    const sessions = ctx.get?.('sessions') as { get?: (id: string) => unknown } | undefined;
    const presets = ctx.get?.('permissionPresets') as { set?: (session: unknown, preset: string) => void } | undefined;
    const session = sessions?.get?.(sessionId);
    if (session !== undefined && presets?.set !== undefined) {
      presets.set(session, 'danger-full-access');
      log.info(`[dsh-pet] 干活会话 ${sessionId} 已设为完全访问`);
    }
  } catch (error) {
    // 权限设不上不是致命错误：这一轮照样能跑，只是遇到审批会等到超时。
    log.warn(`[dsh-pet] 干活会话 ${sessionId} 设置权限失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 跑一轮真正的 agent 任务。
 *
 * 同一只宠物并发调用会直接返回「上一件还没干完」，不会排第二条。
 *
 * @param input - 宿主上下文、日志、宠物与任务正文。
 * @returns 成功时为最终助手正文；失败时为一句话原因。
 */
export async function runPetWork(input: PetWorkInput): Promise<PetWorkResult> {
  const { ctx, log, petId, text } = input;
  if (running.has(petId)) return { ok: false, message: '上一件还没干完，等本鱼腾出手来' };

  const controller = ctx.get?.('sessionController') as
    | {
        create?: (init: { sessionId: string; cwd: string }) => Promise<unknown>;
        prompt?: (request: unknown, signal: AbortSignal) => Promise<unknown>;
      }
    | undefined;
  if (controller?.create === undefined || controller.prompt === undefined) {
    return { ok: false, message: '当前环境没有会话服务，干活模式用不了' };
  }

  running.add(petId);
  const sessionId = sessionIdFor(petId);
  const timeoutMs = Math.max(MIN_TIMEOUT_MS, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let dispose: (() => void) | undefined;
  try {
    const cwd = process.env.DSH_PET_WORK_CWD?.trim() || join(homedir(), '.dsh', 'pet-work');
    await mkdir(cwd, { recursive: true });
    const sessions = ctx.get?.('sessions') as { get?: (id: string) => unknown } | undefined;
    if (sessions?.get?.(sessionId) === undefined) {
      await controller.create({ sessionId, cwd });
    }
    applyFullAccess(ctx, sessionId, log);

    let buffer = '';
    let finish: (() => void) | undefined;
    const ended = new Promise<void>((resolve) => {
      finish = resolve;
    });
    dispose = ctx.on?.('agent/assistant-stream', (payload) => {
      const frame = readFrame(payload, sessionId);
      if (frame.text !== undefined) buffer += frame.text;
      if (frame.ended === true) finish?.();
    });

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    timer.unref?.();
    try {
      await controller.prompt(
        {
          requestId: `pet-work-${randomUUID()}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
        abort.signal,
      );
      await Promise.race([
        ended,
        new Promise<never>((_resolve, reject) => {
          abort.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }

    const out = buffer.trim();
    if (out === '') return { ok: false, message: '干完了，但没拿到回复正文' };
    return { ok: true, text: out };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`[dsh-pet] 干活失败 pet=${petId} session=${sessionId}：${message}`);
    return { ok: false, message: message === 'timeout' ? '干太久了，先停下来（超时）' : message };
  } finally {
    dispose?.();
    running.delete(petId);
  }
}
