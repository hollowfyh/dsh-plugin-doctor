/**
 * dsh-plugin-doctor — 插件体检与自动修复（宿主侧）。
 *
 * 冲突面：DSH 的 Loader 树里，某个插件行在 apply 阶段抛错会被 Cordis 判为
 * fiber「failed」，该行不工作但整个树继续运行——这就是用户感知到的
 * 「插件冲突」。本插件周期扫描 Loader，把失败行通过官方
 * `pluginManager.setPluginEnabled(id, false)` 持久化禁用（写入 profile 的
 * cordis.patch.yml 并触发热重组），让其余插件照常工作；同时落盘报告，
 * 并提供 `/doctor` 斜杠命令随时查看。
 *
 * 安全边界：
 * - 只禁用（不卸载、不改 package.json）；
 * - 不处理自身、plugin-manager 等受保护模块、以及只读行（readOnlyReason）；
 * - 同一进程内每个失败行只尝试修复一次，避免反复重组；
 * - 每次修复写一条 incident 记录，用户可在「插件」页手动重新启用。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'plugin-doctor'

/** Cordis FiberState 数字枚举 → 公共阶段名（与 dsh-host-plugin-inventory 一致）。 */
const FIBER_PHASE = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: null,
  5: 'unloading',
}

/** 永远不自动禁用的模块（禁用它们会破坏插件管理本身）。 */
const PROTECTED_MODULES = new Set([
  '@deepseek-ai/dsh-plugin-manager',
  '@deepseek-ai/dsh-host-plugin-inventory',
])

const DEFAULTS = {
  /** 是否自动禁用加载失败的插件行。 */
  autoFix: true,
  /** 启动后延迟首次扫描的毫秒数（等所有行挂载完成）。 */
  scanDelayMs: 3000,
  /** 运行期扫描间隔（毫秒）；0 表示只在启动时扫描一次。 */
  watchIntervalMs: 15000,
  /** 单次启动最多自动修复的行数。 */
  maxFixesPerBoot: 3,
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function dshHome() {
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

function stateDir() {
  const dir = join(dshHome(), 'plugin-doctor')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.tmp-${String(process.pid)}-${String(Date.now())}`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
}

function appendIncident(file, incident) {
  appendFileSync(file, `${JSON.stringify(incident)}\n`, 'utf8')
}

/** 读一份插件行快照；优先用 pluginManager.listPlugins（带只读原因），否则直读 Loader。 */
async function readRows(ctx) {
  const manager = ctx.get('pluginManager')
  if (manager !== undefined && typeof manager.listPlugins === 'function') {
    return { rows: await manager.listPlugins(), manager }
  }
  const loader = ctx.get('loader')
  const entries = loader === undefined ? [] : [...loader.entries()]
  const rows = []
  for (const entry of entries) {
    if (entry.options?.group === true) continue
    const fiber = entry.fiber
    rows.push({
      entryId: entry.id,
      moduleName: entry.options?.name,
      enabled: entry.disabled !== true,
      fiberPhase: fiber === undefined || fiber === null ? null : (FIBER_PHASE[fiber.state] ?? null),
    })
  }
  return { rows, manager: undefined }
}

function formatReport(report) {
  const lines = []
  lines.push(`插件体检报告（${report.at}）`)
  lines.push(`共 ${String(report.total)} 个插件行：活跃 ${String(report.active)}，失败 ${String(report.failed.length)}，本次自动修复 ${String(report.fixed.length)}`)
  if (report.fixed.length > 0) {
    lines.push('')
    lines.push('已自动修复（已禁用，可在「插件」页重新启用或先更新插件）：')
    for (const item of report.fixed) {
      lines.push(`  ✓ ${item.moduleName}（${item.entryId}）：加载失败 → 已禁用`)
    }
  }
  if (report.skipped.length > 0) {
    lines.push('')
    lines.push('未能自动修复：')
    for (const item of report.skipped) {
      lines.push(`  ✗ ${item.moduleName}（${item.entryId}）：${item.reason}`)
    }
  }
  if (report.dormant.length > 0) {
    lines.push('')
    lines.push('启用但未挂载（可能导入失败，建议检查模块名/依赖）：')
    for (const item of report.dormant) {
      lines.push(`  ? ${item.moduleName}（${item.entryId}）`)
    }
  }
  if (report.errors.length > 0) {
    lines.push('')
    lines.push('读取异常：')
    for (const error of report.errors) lines.push(`  ! ${error}`)
  }
  if (report.failed.length === 0 && report.errors.length === 0) {
    lines.push('')
    lines.push('没有发现加载失败的插件。')
  }
  lines.push('')
  lines.push('配置文件：$DSH_HOME/plugin-doctor/report.json；修复记录：incidents.jsonl')
  return lines.join('\n')
}

/**
 * 调 pluginManager.setPluginEnabled 禁用一行。
 *
 * 坑：如果本插件是在一次 HMR 热重组中挂载的，apply() 里的定时器会继承那次
 * 事务的 AsyncLocalStorage 上下文；HMR 的 runExclusive 看到该上下文就拒绝
 * 「HMR transactions cannot be nested」。用 AsyncLocalStorage.exit() 在回调
 * 内临时清空 HMR 的 executing 上下文，再调用即可成功；拿不到该内部字段时
 * 回退为直接调用。
 */
async function disableRow(ctx, manager, entryId) {
  const call = () => manager.setPluginEnabled(entryId, false)
  const hmr = ctx.get('hmr')
  const storage = hmr?.executing
  if (storage !== undefined && typeof storage.exit === 'function') {
    return await storage.exit(call)
  }
  return await call()
}

/**
 * 修复前备份 profile 的 cordis.patch.yml（每进程一次，带时间戳）。
 * @returns 备份文件路径；原文件不存在时返回 undefined。
 */
function backupPatchFile(profile, dir) {
  const file = join(dshHome(), 'profiles', profile, 'cordis.patch.yml')
  if (!existsSync(file)) return undefined
  const backupDir = join(dir, 'backups')
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(backupDir, `cordis.patch.yml.${stamp}.bak`)
  copyFileSync(file, target)
  return target
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const selfEntryId = ctx.fiber?.entry?.id
  const dir = stateDir()
  const reportFile = join(dir, 'report.json')
  const incidentsFile = join(dir, 'incidents.jsonl')
  /** 本进程内是否已备份过 patch 文件。 */
  let backedUp = false
  /** 本进程内已尝试修复过的 entryId（避免反复重组）。 */
  const attempted = new Set()
  /** 每个 entryId 的修复尝试次数（临时冲突允许有限重试）。 */
  const attemptCounts = new Map()
  const MAX_ATTEMPTS = 6
  /** pluginManager 在 HMR 事务期间被调用会抛出的临时冲突。 */
  const TRANSIENT_CONFLICT = /HMR transactions cannot be nested/

  /** 一次完整扫描 + 修复；返回结构化报告。 */
  async function scan() {
    const report = {
      at: new Date().toISOString(),
      total: 0,
      active: 0,
      failed: [],
      dormant: [],
      fixed: [],
      skipped: [],
      errors: [],
    }
    let rows = []
    let manager
    try {
      const read = await readRows(ctx)
      rows = read.rows
      manager = read.manager
    } catch (error) {
      report.errors.push(`读取插件清单失败：${messageOf(error)}`)
      writeJsonAtomic(reportFile, report)
      return report
    }

    report.total = rows.length
    for (const row of rows) {
      if (row.fiberPhase === 'active') {
        report.active += 1
        continue
      }
      if (row.fiberPhase !== 'failed') continue
      report.failed.push({
        entryId: row.entryId,
        moduleName: row.moduleName,
        readOnlyReason: row.readOnlyReason ?? null,
      })
    }

    // 启用但根本没有存活 fiber 的行（常见于导入失败/从未启动），单独列出便于诊断。
    report.dormant = rows
      .filter((row) => row.enabled === true && row.fiberPhase === null && row.entryId !== selfEntryId)
      .map((row) => ({ entryId: row.entryId, moduleName: row.moduleName }))

    for (const failed of report.failed) {
      const skip = (reason) => {
        report.skipped.push({ ...failed, reason })
      }
      if (cfg.autoFix !== true) {
        skip('自动修复已关闭（可在插件配置里打开 autoFix）')
        continue
      }
      if (report.fixed.length >= cfg.maxFixesPerBoot) {
        skip('达到单次启动修复上限')
        continue
      }
      if (failed.entryId === selfEntryId) {
        skip('不处理自身')
        continue
      }
      if (PROTECTED_MODULES.has(failed.moduleName)) {
        skip('受保护模块，不自动禁用')
        continue
      }
      if (failed.readOnlyReason !== null) {
        skip(`只读行：${failed.readOnlyReason}`)
        continue
      }
      if (attempted.has(failed.entryId)) {
        skip('本进程已处理过该行，跳过')
        continue
      }
      if (manager === undefined) {
        skip('宿主未提供 pluginManager 服务，无法持久化禁用')
        continue
      }
      if ((attemptCounts.get(failed.entryId) ?? 0) >= MAX_ATTEMPTS) {
        skip('多次修复失败，已放弃（请手动处理）')
        continue
      }
      const attempt = (attemptCounts.get(failed.entryId) ?? 0) + 1
      attemptCounts.set(failed.entryId, attempt)
      if (!backedUp) {
        try {
          const profile = ctx.get('profileContext')?.name ?? process.env.DSH_PROFILE
          if (typeof profile === 'string' && profile !== '') {
            const backup = backupPatchFile(profile, dir)
            if (backup !== undefined) appendIncident(incidentsFile, { at: report.at, action: 'backup', file: backup })
          }
          backedUp = true
        } catch (error) {
          report.errors.push(`备份 patch 失败：${messageOf(error)}`)
        }
      }
      try {
        const result = await disableRow(ctx, manager, failed.entryId)
        attempted.add(failed.entryId)
        const fixed = {
          ...failed,
          result: {
            application: result?.application ?? null,
            changed: result?.changed ?? null,
            error: result?.error ?? null,
          },
        }
        report.fixed.push(fixed)
        appendIncident(incidentsFile, { at: report.at, action: 'disable', ...fixed })
      } catch (error) {
        const text = messageOf(error)
        appendIncident(incidentsFile, { at: report.at, action: 'disable-failed', entryId: failed.entryId, attempt, error: text })
        if (TRANSIENT_CONFLICT.test(text)) {
          skip(`临时冲突（${text}），第 ${String(attempt)}/${String(MAX_ATTEMPTS)} 次尝试，稍后重试`)
        } else {
          attempted.add(failed.entryId)
          skip(`修复失败：${text}`)
        }
      }
    }

    writeJsonAtomic(reportFile, report)
    if (report.failed.length > 0 || report.errors.length > 0) {
      console.warn(`[plugin-doctor] ${formatReport(report)}`)
    }
    return report
  }

  function runScan(initial) {
    scan().catch((error) => {
      console.warn(`[plugin-doctor] ${initial ? '启动扫描' : '周期扫描'}失败：${messageOf(error)}`)
    })
  }

  // 启动后延迟首次扫描。
  ctx.effect(() => {
    const timer = setTimeout(() => runScan(true), cfg.scanDelayMs)
    return () => clearTimeout(timer)
  }, 'plugin-doctor: boot scan')

  // 运行期周期扫描：捕获热重组/插件安装之后新出现的失败行。
  if (cfg.watchIntervalMs > 0) {
    ctx.effect(() => {
      const interval = setInterval(() => runScan(false), cfg.watchIntervalMs)
      return () => clearInterval(interval)
    }, 'plugin-doctor: watch scan')
  }

  // /doctor 斜杠命令：随时手动体检（不会自动修复，只报告并落盘）。
  ctx.effect(() => {
    const commands = ctx.get('commands')
    if (commands === undefined || typeof commands.register !== 'function') return
    const off = commands.register({
      name: 'doctor',
      description: '插件体检：列出加载失败的插件行并汇报自动修复记录',
      handler: async () => {
        const report = await scan()
        return { kind: 'success', text: formatReport(report) }
      },
    })
    return () => off()
  }, 'plugin-doctor: /doctor command')
}
