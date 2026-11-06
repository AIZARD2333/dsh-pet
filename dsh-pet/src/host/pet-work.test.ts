/**
 * 干活模式的自检：不依赖 DSH 运行时，用假 ctx 驱动 assistant-stream 帧。
 *
 * @module dsh-pet/src/host/pet-work.test
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isPetWorking, runPetWork } from './pet-work.ts';

// 测试跑在沙箱里，默认家目录不可写；把干活工作区指到系统临时目录。
process.env.DSH_PET_WORK_CWD = mkdtempSync(join(tmpdir(), 'pet-work-'));

/** 记录日志，供断言之外的人工排查用。 */
const log = {
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

/** 造一个最小宿主：sessionController + sessions + permissionPresets + 事件订阅。 */
function makeHost(options: { emit?: boolean } = {}) {
  let listener: ((payload: unknown) => void) | undefined;
  const emitted: string[] = [];
  const controller = {
    async create(): Promise<void> {
      emitted.push('create');
    },
    async prompt(): Promise<void> {
      emitted.push('prompt');
      if (options.emit !== false) {
        setTimeout(() => {
          listener?.({
            agent: { session: { id: 'pet-work-main' } },
            frame: { chunk: { type: 'text-delta', text: '改好了。' } },
          });
          listener?.({ agent: { session: { id: 'pet-work-main' } }, frame: { type: 'end' } });
        }, 0);
      }
    },
  };
  const ctx = {
    get(name: string): unknown {
      if (name === 'sessionController') return controller;
      if (name === 'sessions') return { get: (): unknown => ({}) };
      if (name === 'permissionPresets') return { set: (): void => undefined };
      return undefined;
    },
    on(_event: string, callback: (payload: unknown) => void): () => void {
      listener = callback;
      return (): void => undefined;
    },
  };
  return { ctx, emitted };
}

test('runPetWork returns the assistant text and clears the busy flag', async () => {
  const { ctx } = makeHost();
  const result = await runPetWork({ ctx, log, petId: 'main', text: '把 README 的错字改掉' });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.text, '改好了。');
  assert.equal(isPetWorking('main'), false);
});

test('runPetWork refuses a second turn for the same pet while one runs', async () => {
  const { ctx } = makeHost({ emit: false });
  const first = runPetWork({ ctx, log, petId: 'main', text: '慢慢来' });
  const second = await runPetWork({ ctx, log, petId: 'main', text: '再来一件' });
  assert.equal(second.ok, false);
  assert.match(second.ok ? '' : second.message, /还没干完/);
  // 释放第一轮：发一个 end 帧，别把测试挂着。
  void first;
});
