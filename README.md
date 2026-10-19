# dsh-plugin-doctor

插件体检与自动修复。当某个插件行在加载时发生冲突（apply 抛错、服务重复注册、依赖缺失等），DSH 会把它标记为 `failed` 并让它停摆，但整个宿主继续运行。本插件周期扫描 Loader 树：

- 发现 `failed` 行时，调用官方 `pluginManager.setPluginEnabled(id, false)` **持久化禁用**该行（写入 profile 的 `cordis.patch.yml` 并触发热重组），让其余插件照常工作；
- 每次修复写入 `$DSH_HOME/plugin-doctor/incidents.jsonl`，整份报告写入 `report.json`；
- 注册 `/doctor` 斜杠命令，随时手动体检。

## 配置（profile 的 `cordis.patch.yml` 里给本行加 config）

```yaml
- id: plugin-doctor
  name: 'dsh-plugin-doctor'
  config:
    autoFix: true        # 默认 true：自动禁用加载失败的行
    scanDelayMs: 3000    # 启动后延迟首次扫描的毫秒数
    watchIntervalMs: 12000  # 运行期扫描间隔（0 = 只在启动时扫描一次）
    maxFixesPerBoot: 3   # 单次启动最多自动修复的行数
```

## 安全边界

- 只禁用，不卸载、不改 `package.json` 依赖；
- 不处理自身、`dsh-plugin-manager` 与插件清单模块，以及只读行（`readOnlyReason`）；
- 修复数量有上限；临时冲突（`HMR transactions cannot be nested`）自动重试，最多 6 次；
- 被修复的行在「插件」页仍可手动重新启用；修复记录完整可查。

## 报告格式

`report.json` 每次扫描重写：

```json
{
  "at": "…",
  "total": 199,
  "active": 174,
  "failed": [{ "entryId": "…", "moduleName": "…", "readOnlyReason": null }],
  "dormant": [],
  "fixed": [{ "entryId": "…", "result": { "application": "applied", "changed": true } }],
  "skipped": [{ "entryId": "…", "reason": "…" }],
  "errors": []
}
```

`dormant` = 启用但没有任何存活 fiber 的行（常见于模块导入失败），仅报告、不自动处理。

## 测试

- `node test/smoke.mjs`：假上下文下的 4 个场景（正常禁用 / 临时冲突重试 / autoFix 关闭 / 修复上限）。
- `test/broken-plugin.mjs`：故意在 apply 抛错的测试插件，可通过 patch 的 `insert` 行临时装载，验证端到端自动修复（实测通过：失败行被禁用并写入 `disabled: true`）。

## 实现细节

- **失败检测**：优先 `pluginManager.listPlugins()`（带 `readOnlyReason` 与 `fiberPhase`），拿不到时直读 `ctx.loader.entries()` 并按 `fiber.state` 映射阶段。
- **修复**：`pluginManager.setPluginEnabled(entryId, false)` —— 官方开关 API，写入 profile 的 `cordis.patch.yml` 并触发 HMR 重组。
- **HMR 上下文坑**：本插件若在一次热重组中被挂载，apply 里创建的定时器会继承那次事务的 `AsyncLocalStorage` 上下文，`runExclusive` 会以 "HMR transactions cannot be nested" 拒绝修复。因此修复调用包在 `hmr.executing.exit(callback)` 里（临时清空事务上下文）；拿不到该字段时回退直接调用。此路径已在桌面实例实测通过。

## 局限

- 只看宿主侧 Loader 行；浏览器端模块加载失败、slot 层 UI 重叠不在本插件范围内。
- 若失败发生在宿主启动的极早期（Loader 树本身起不来），本插件同样无法启动——需要人工介入。
- 导入失败（模块不存在）通常不产生 `failed` fiber，只在 `dormant` 里出现；被 `dormant` 记录的模块需要人工检查模块名/依赖。

## 目录

```
lib/index.js       宿主侧插件实现
cordis.patch.yml   本 bundle 的插入行
test/smoke.mjs     假上下文冒烟测试
test/broken-plugin.mjs  端到端故障注入插件
```
