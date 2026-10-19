/**
 * dsh-plugin-doctor 冒烟测试：用假上下文驱动 apply()，验证
 *   1) failed 行会被 setPluginEnabled(id, false) 持久化禁用；
 *   2) 临时冲突（HMR transactions cannot be nested）会重试并在恢复后成功；
 *   3) 只读行 / 自身 / 受保护模块不被处理；
 *   4) report.json 与 incidents.jsonl 正确落盘。
 * 运行：node test/smoke.mjs
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const home = mkdtempSync(join(tmpdir(), 'plugin-doctor-test-'))
process.env.DSH_HOME = home

const { apply } = await import('../lib/index.js')

function makeCtx(manager, selfId = 'self') {
  const disposers = []
  return {
    fiber: { entry: { id: selfId } },
    get(name) {
      if (name === 'pluginManager') return manager
      if (name === 'commands') return { register: () => () => {} }
      return undefined
    },
    effect(cb) {
      const disposer = cb()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    disposeAll() {
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
}

const rows = [
  { entryId: 'self', moduleName: 'dsh-plugin-doctor', enabled: true, fiberPhase: 'active' },
  { entryId: 'good', moduleName: 'good-plugin', enabled: true, fiberPhase: 'active' },
  { entryId: 'bad', moduleName: 'bad-plugin', enabled: true, fiberPhase: 'failed', readOnlyReason: null },
  { entryId: 'locked', moduleName: 'locked-plugin', enabled: true, fiberPhase: 'failed', readOnlyReason: 'unaddressable' },
  { entryId: 'pm', moduleName: '@deepseek-ai/dsh-plugin-manager', enabled: true, fiberPhase: 'failed', readOnlyReason: null },
]

// —— 场景 1：正常禁用 ——
{
  const calls = []
  const manager = {
    async listPlugins() { return rows },
    async setPluginEnabled(id, enabled) { calls.push([id, enabled]); return { application: 'applied', changed: true } },
  }
  const ctx = makeCtx(manager)
  apply(ctx, { autoFix: true, scanDelayMs: 30, watchIntervalMs: 0, maxFixesPerBoot: 3 })
  await new Promise((r) => setTimeout(r, 250))
  ctx.disposeAll()

  assert.deepEqual(calls, [['bad', false]], '只有可修复的失败行被禁用')
  const report = JSON.parse(readFileSync(join(home, 'plugin-doctor', 'report.json'), 'utf8'))
  assert.equal(report.failed.length, 3, '三个失败行都被报告')
  assert.equal(report.fixed.length, 1, '只有一个被自动修复')
  assert.equal(report.fixed[0].entryId, 'bad')
  assert.ok(report.skipped.some((s) => s.entryId === 'locked' && /只读/.test(s.reason)), '只读行给出原因')
  assert.ok(report.skipped.some((s) => s.entryId === 'pm' && /受保护/.test(s.reason)), '受保护模块给出原因')
  assert.ok(report.skipped.every((s) => s.entryId !== 'self'), '自身不在失败列表')
  assert.ok(existsSync(join(home, 'plugin-doctor', 'incidents.jsonl')), 'incidents 落盘')
  console.log('场景 1（正常禁用）通过')
}

// —— 场景 2：临时冲突后重试成功 ——
{
  let attempt = 0
  const calls = []
  const manager = {
    async listPlugins() { return [rows[2]] },
    async setPluginEnabled(id, enabled) {
      attempt += 1
      if (attempt < 3) throw new Error('HMR transactions cannot be nested')
      calls.push([id, enabled])
      return { application: 'applied', changed: true }
    },
  }
  const ctx = makeCtx(manager)
  apply(ctx, { autoFix: true, scanDelayMs: 20, watchIntervalMs: 40, maxFixesPerBoot: 3 })
  await new Promise((r) => setTimeout(r, 400))
  ctx.disposeAll()
  assert.deepEqual(calls, [['bad', false]], '重试后成功禁用一次（不重复）')
  console.log(`场景 2（临时冲突重试）通过，共尝试 ${attempt} 次`)
}

// —— 场景 3：autoFix 关闭 ——
{
  const calls = []
  const manager = {
    async listPlugins() { return [rows[2]] },
    async setPluginEnabled(id, enabled) { calls.push([id, enabled]); return { application: 'applied', changed: true } },
  }
  const ctx = makeCtx(manager)
  apply(ctx, { autoFix: false, scanDelayMs: 20, watchIntervalMs: 0, maxFixesPerBoot: 3 })
  await new Promise((r) => setTimeout(r, 200))
  ctx.disposeAll()
  assert.deepEqual(calls, [], 'autoFix=false 时不做任何修复')
  console.log('场景 3（autoFix 关闭）通过')
}

// —— 场景 4：达到修复上限 ——
{
  const manyBad = [
    { entryId: 'b1', moduleName: 'bad1', enabled: true, fiberPhase: 'failed', readOnlyReason: null },
    { entryId: 'b2', moduleName: 'bad2', enabled: true, fiberPhase: 'failed', readOnlyReason: null },
    { entryId: 'b3', moduleName: 'bad3', enabled: true, fiberPhase: 'failed', readOnlyReason: null },
  ]
  const calls = []
  const manager = {
    async listPlugins() { return manyBad },
    async setPluginEnabled(id) { calls.push(id); return { application: 'applied', changed: true } },
  }
  const ctx = makeCtx(manager)
  apply(ctx, { autoFix: true, scanDelayMs: 20, watchIntervalMs: 0, maxFixesPerBoot: 2 })
  await new Promise((r) => setTimeout(r, 250))
  ctx.disposeAll()
  assert.deepEqual(calls, ['b1', 'b2'], '只修复上限内的行')
  console.log('场景 4（修复上限）通过')
}

console.log('全部冒烟测试通过 ✔')
process.exit(0)
