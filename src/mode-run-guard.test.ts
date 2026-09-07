import { expect, it } from 'vitest';
import { captureModeRun, invalidateModeRun } from './mode-run-guard.js';

it('切走又切回不复活旧输出，其他群不受影响', () => {
  const old = captureModeRun('as-a');
  const other = captureModeRun('as-b');
  invalidateModeRun('as-a');
  const next = captureModeRun('as-a');
  expect(old()).toBe(false);
  expect(next()).toBe(true);
  invalidateModeRun('as-a');
  expect(old()).toBe(false);
  expect(next()).toBe(false);
  expect(other()).toBe(true);
});
