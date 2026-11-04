# 本轮里程碑：安装到真实 Harness，跑通模型、工具与独立验收

记录日期：2026-11-04。本轮只完成一个小闭环，不把工程推进等同于个人学习验收。

## 已经完成什么

修改版已打包为 `@agent-loopguard/plugin@0.1.0-dev.1`，通过桌面版自带的 CLI 安装到项目专用 `loopguard` profile。包声明了模块入口、bundle 配置补丁与固定 DSH 兼容范围。profile 的配置树确认插件被选择，三项语义开关已开启；真实工具调用中也捕获到了插件决策。

本轮不是把脚本固定的工具动作换个名字。使用的是官方 headless runner、真实 Agent、官方文件工具和 DeepSeek 模型。任务由模型自行决定工具调用；观察插件只记录与限额，不提供模型输出或工具结果。

## 怎样安装与加载

```text
npm pack 本地修改版
  → dsh plugin --profile loopguard add 本地tgz
  → 包的 dsh.bundle.patch 指向 cordis.patch.yml
  → profile 组合插件配置树
  → 宿主加载 @agent-loopguard/plugin 的 apply
  → 注册工具守卫和结果监听器
```

对应文件：

- `packages/loopguard/package.json`：主入口、资源导出、打包文件及 `engines.dsh`。
- `packages/loopguard/cordis.patch.yml`：插入 `loopguard` 节点并显式开启三项机制。
- `tools/prepare-profile.mjs`：创建项目专用 profile、打包、安装、核对配置。只更新空配置或本工具上次管理的配置；未知编辑会拒绝覆盖。
- `config/smoke-profile.patch.yml`：将官方 API-key 路由与模型选择映射到真实 Harness，限制单次输出，关闭额外标题生成。

项目自己的 `DSH_HOME` 是 `.runtime/dsh-home`，没有修改日常桌面 profile。包仍是私有开发包，已验证本地tgz安装，尚未发布到npm。自更新默认关闭，避免开发副本自动替换成其他发布内容。本轮未验证Web客户端界面。

安装过程中，pnpm默认缓存需要在外部缓存目录登记符号链接，受限环境返回EPERM。将store放在该profile内部并关闭全局虚拟store后，安装成功；没有修改Windows系统权限。运行时使用官方的模块解析机制，解析宿主提供的依赖。

## 怎样复现

需要本机已有 Windows 桌面 CLI（当前验证版本 `0.2.1-rc.2`），Node.js 24+ 与 Python 3.12。路径可通过 `DSH_LOOPGUARD_CLI` 指定。

```powershell
Set-Location -LiteralPath 'D:\其他\简历相关\agent-loopguard'

# 打包、安装并核对插件配置；不调用模型
npm.cmd run profile:prepare

# 本地回归：38条Node用例 + 7条Python验收器用例；不调用模型
npm.cmd test

# 使用启动环境中的DEEPSEEK_API_KEY，实际调用模型
npm.cmd run smoke:agent

# 可用另一个输入检查相同任务类型
npm.cmd run smoke:agent -- --counter 7

# 汇总本地运行记录
npm.cmd run report:agent
```

本地模型密钥只从环境继承，不进入配置或命令参数；输出日志写入前会替换可能出现的密钥原值。官方模型目录检查使用API根地址，Harness的Messages传输使用 `/anthropic` 根地址，两者不可混为同一配置字段。

## 这一个任务怎样运行

任务：读取 `input.json` 的整数counter，加一后创建 `result.json`，然后重新读取结果检查。

本次成功轨迹均为：

```text
模型请求1 → 原生read读取输入
模型请求2 → 原生write创建结果
模型请求3 → 原生read检查结果
模型请求4 → 最终回复
```

输入41得到42，输入7得到8。两次成功运行都经过4轮模型请求、3次工具调用、0次工具错误，并产生6条LoopGuard决策事件。本次分别耗时6.062秒和7.5秒；这些是整条测试流程的记录，不是插件独立开销或普遍速度收益。

这是“读取输入、派生新文件”的任务，读前后的文件路径不同，不应把它描述为已经在完整模型中验证了同文件读改再读策略收益。

## 为什么需要独立验收

Python同时检查：进程正常退出、最终事件与回合终态、结果内容、成功的原生读写顺序、插件决策和限额状态。最新验收另外确认输入不变；结果期望值来自运行前的参数，不信任模型修改后的输入，也不把布尔值当整数答案。

`lab/smoke-recorder.mjs` 限制最多6次pre-step准入、8次可进入其检查的工具请求，只允许两个任务文件，输入只读；Python设置120秒墙钟上限。DSH内部仍是workspace-write。观察器对外只记录工具身份、有限状态、摘要哈希和提供方usage，不记录模型推理文本。

7条Python回归包含：正确产物、只回复DONE却无产物、布尔值冒充整数、篡改输入改变期望答案、同名但越界路径、写入失败、预算触发。这些是验收器的合成单元测试，不计为真实模型任务。

## 失败尝试也保留

1. 首轮提示词中的 `answer` 被上游保留的停止词规则识别为停止要求，文件未生成，虽然进程退出码为0。该语境误拦已作为独立缺陷留档，本轮没有扩展到停止意图识别。
2. 改用无歧义的 `reply` 后，模型能读文件，但当前外层沙箱拒绝原生文件工具用hard-link进行原子创建。工具错误进入了插件状态，下一次相同写入被重复规则拒绝。
3. 在正常外层执行权限下，同一任务成功。DSH内部权限和测试文件限制仍保留，并未改成danger-full-access。当前受限环境中若再次出现同样的原子创建EPERM，应从普通本机PowerShell验证，不能将其误报为模型任务通过。

完整聚合记录见 [安装与真实任务报告](experiments/harness-smoke-2026-11-04.md)和[JSON](experiments/harness-smoke-2026-11-04.json)。原始会话、轨迹和产物保留在Git忽略的 `.runtime/`、`results/agent-smoke/`。

## 本轮结论与后续

现在能确认：本地分发包可以安装并被真实宿主加载，模型能够自主调用原生工具，修改版能观察执行结果，独立验收可以区分程序退出与任务完成。

当前是一个任务类型的接入验证；没有A/B/C/D完整模型任务对照，也没有三项语义策略的Token或任务完成收益结论。这次实际使用read/write，shell与job_output专属机制仍以已有组件证据为准。下一步先理解这条完整轨迹，再选一个能自动验收的shell或后台任务做小规模成对比较。

供简历对话的事实摘要：

- 完成模块：可安装的原生插件bundle、隔离profile安装工具、有资源上限的真实模型任务入口、轨迹与产物独立验收。
- 本人参与：需求与机制讨论；本轮编码和自动运行由助手执行，个人独立操作、代码理解和实际用时继续单独验收。
- 实验口径：38条Node回归、7条Python验收器回归；1类真实模型任务的2个成功实例，另保留2次失败排障记录。
- 实测结果：成功实例均为4轮模型请求、3次原生工具、0工具错误、6条插件决策；产物分别由41生成42、由7生成8。
- 公开产物：代码、说明与脱敏聚合报告随本轮版本提交到项目仓库，实际版本以Git历史为准；本地原始会话不上传。

核实依据：固定提交的[官方启动与profile文档](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/README.md)、[headless说明](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/headless/README.md)，以及本机CLI帮助和实际运行。引用源码解释契约，运行事实以本机轨迹为准。
