# Agent LoopGuard

基于 DeepSeek Harness 原生工具运行时，改进工具循环中的操作身份、结果证据与后台等待判断。技术栈：Node.js / JavaScript 插件，Python 夹具与评测统计。

当前是**有限范围的组件验证版本**：已修复结果事件接入及调用生命周期，并实现三项可独立开启的语义机制；完整模型 Agent 任务评测尚未完成。

## 三条规则

| 机制 | 已实现行为 | 边界 |
|---|---|---|
| 操作身份 | bash/pwsh 的有效 description 不改变实际操作身份 | 保留命令、工作目录、权限、超时与未知执行参数；不压缩命令内部空白 |
| 结果证据 | 区分工具返回成功与程序退出状态；已知 unittest 时间噪声不算新证据 | 仅去除明确的测试时间字段；新错误与成功结果仍可见，原始日志保留 |
| 有限等待 | running 不刷新进展；按作业和 turn 限制次数、时长和频率 | 依赖宿主 wait/timeout 与可选作业注册表；不是进程取消器或新调度框架 |

默认保留接入/生命周期基线。通过 `semanticActions`、`semanticEvidence`、`semanticWaits` 三个配置开关开启，实验 D 组开启全部。

## 运行

需要 Node.js 24+、Python 3.12，以下命令可在 PowerShell 中运行：

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd test
npm.cmd run semantics
npm.cmd run report:semantics
npm.cmd run verify:vendor
```

教学入口：`npm.cmd run day1` 演示原版误拦；`npm.cmd run day1 -- --working` 演示正式结果接入。读→写→再读共有三次调用、两次读取；被拦的是第三次调用，即第二次读取。

## 已测结果

38 条自动回归通过；33 条组件轨迹包含 A/B/B-safe/C/D 五组的 30 条主对照和 3 条消融。另保留既有 19 条原版/桥接缺陷与控制回放。

| 场景 | 接入与生命周期基线 B-safe | 三项机制 D |
|---|---|---|
| 同命令仅改描述 | 8 次请求均执行 | 执行 2 次，第 3 次请求被拒 |
| 实际失败测试仅时间噪声变化 | 8 次失败均执行 | 执行 2 次，第 3 次请求被拒 |
| 正常后台工作 | 第 3 次查询被拒，工作当时仍在运行 | 取回完成结果 |
| 持续 running，场景约定最多 4 次等待 | 第 3 次查询因重复被拒 | 允许 4 次等待，第 5 次因等待预算拒绝 |

调宽阈值 C 组也能完成本例正常等待，但会继续放行两类重复失败；逐项关闭语义开关的消融会恢复对应缺陷。详细数据见[组件对照报告](docs/experiments/semantic-components-2026-11-03.md)及[聚合 JSON](docs/experiments/semantic-components-2026-11-03.json)。

这些是受控组件轨迹，使用真实 Cordis、ToolRuntime、文件操作、Python 测试与后台子进程；工具定义、作业注册表接口和 Agent handle 是夹具，动作由脚本固定。没有模型自主规划、完整任务成功率、Token 或普遍成本收益结论。

## 阅读顺序

- [一页机制与结果说明](docs/面试速读.md)
- [项目总览](docs/项目总览.md)与[执行计划](docs/项目执行计划.md)
- [结果事件与生命周期](docs/day02-result-integration.md)
- [进度记录](docs/progress.txt)

实现集中于 `packages/loopguard/lib/`；回放入口在 `lab/`；回归在 `tests/`；Python 统计在 `eval/`。本地完整日志在 Git 忽略的 `results/`，仓库提交聚合结果和复现入口。

上游：`@goodandready/dsh-agent-loop-guard@0.2.24`。`vendor/` 保留固定发布包和 MIT 许可证，未修改；来源和依赖版本见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)、[versions.json](versions.json)。
