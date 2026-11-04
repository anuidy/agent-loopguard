# Agent LoopGuard

基于 DeepSeek Harness 原生工具运行时，改进工具循环中的操作身份、结果证据与后台等待判断。技术栈：Node.js / JavaScript 插件，Python 夹具与评测统计。

当前已实现结果接入、生命周期及三项可选语义机制，并提供**可安装的 headless 插件 bundle**。已有一类真实模型文件任务的两个成功实例；多任务策略收益评测尚未完成。

## 三条规则

| 机制 | 已实现行为 | 边界 |
|---|---|---|
| 操作身份 | bash/pwsh 的有效 description 不改变实际操作身份 | 保留命令、工作目录、权限、超时与未知执行参数；不压缩命令内部空白 |
| 结果证据 | 区分工具返回成功与程序退出状态；已知 unittest 时间噪声不算新证据 | 仅去除明确的测试时间字段；新错误与成功结果仍可见，原始日志保留 |
| 有限等待 | running 不刷新进展；按作业和 turn 限制次数、时长和频率 | 依赖宿主 wait/timeout 与可选作业注册表；不是进程取消器或新调度框架 |

模块默认保留接入/生命周期基线。通过 `semanticActions`、`semanticEvidence`、`semanticWaits` 三个配置开关开启；组件实验 D 组和本项目的安装 bundle 显式开启全部。

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

## 安装到真实 Harness 并验证

当前入口针对 Windows 已安装的桌面 CLI `0.2.1-rc.2`；使用项目自己的 `DSH_HOME`，不修改日常桌面 profile。包仍为私有开发包，安装使用本地 tgz，未发布到 npm。

```powershell
# 打包、安装到隔离的 loopguard profile 并检查配置；不调用模型
npm.cmd run profile:prepare

# 继承环境中的 DEEPSEEK_API_KEY，真实调用模型；有轮次/工具/时间上限
npm.cmd run smoke:agent

# 查看本地运行记录摘要
npm.cmd run report:agent
```

本轮成功实例均由模型自行完成原生 `read → write → read`，Python独立验收产物与轨迹。每例4轮模型请求、3次工具调用、0工具错误；一类任务、两个输入实例，不作为策略收益或成功率基准。

在当前受限执行环境中，原生文件的原子创建曾返回EPERM；从普通本机PowerShell运行通过，DSH内部仍保留workspace-write和两个测试文件限制。首轮停止词误拦及该环境失败均保留记录。安装步骤、环境差异与验收口径见[真实接入说明](docs/harness-integration.md)和[运行报告](docs/experiments/harness-smoke-2026-11-04.md)。

## 已测结果

`npm.cmd test`包含38条Node回归和7条Python验收器回归，均不调用模型。另有33条组件轨迹：A/B/B-safe/C/D五组的30条主对照和3条消融；既有19条原版/桥接回放保留。

| 场景 | 接入与生命周期基线 B-safe | 三项机制 D |
|---|---|---|
| 同命令仅改描述 | 8 次请求均执行 | 执行 2 次，第 3 次请求被拒 |
| 实际失败测试仅时间噪声变化 | 8 次失败均执行 | 执行 2 次，第 3 次请求被拒 |
| 正常后台工作 | 第 3 次查询被拒，工作当时仍在运行 | 取回完成结果 |
| 持续 running，场景约定最多 4 次等待 | 第 3 次查询因重复被拒 | 允许 4 次等待，第 5 次因等待预算拒绝 |

调宽阈值 C 组也能完成本例正常等待，但会继续放行两类重复失败；逐项关闭语义开关的消融会恢复对应缺陷。详细数据见[组件对照报告](docs/experiments/semantic-components-2026-11-03.md)及[聚合 JSON](docs/experiments/semantic-components-2026-11-03.json)。

以上策略比较仍来自受控组件轨迹：真实 Cordis、ToolRuntime、文件、Python测试与后台子进程配合夹具和固定动作。新增模型smoke验证安装与工具连通性，使用原生read/write，未测shell/job策略的完整任务收益；没有普遍成功率或成本节省结论。

## 阅读顺序

- [一页机制与结果说明](docs/面试速读.md)
- [真实Harness接入与首个任务](docs/harness-integration.md)
- [项目总览](docs/项目总览.md)与[执行计划](docs/项目执行计划.md)
- [结果事件与生命周期](docs/day02-result-integration.md)
- [进度记录](docs/progress.txt)

实现集中于 `packages/loopguard/lib/`；回放入口在 `lab/`；回归在 `tests/`；Python 统计在 `eval/`。本地完整日志在 Git 忽略的 `results/`，仓库提交聚合结果和复现入口。

上游：`@goodandready/dsh-agent-loop-guard@0.2.24`。`vendor/` 保留固定发布包和 MIT 许可证，未修改；来源和依赖版本见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)、[versions.json](versions.json)。
