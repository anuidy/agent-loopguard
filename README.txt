Agent LoopGuard Lab
DeepSeek Harness 工具语义感知循环控制
技术栈：Node.js 原生插件与回放；Python 任务评测、夹具和统计。

当前工程阶段：有限语义机制组件版，结果接入、调用生命周期及三项可选语义规则已实现。
个人操作与理解验收单独记录，尚未确认；完整模型任务评测待完成。当前说明优先看 README.md。

在 PowerShell 中运行
Set-Location -LiteralPath 'D:\其他\简历相关\agent-loopguard'
npm.cmd run day1

默认示例：真实文件读→改→再读，第三次调用（第二次读取）被原版守卫拦截。
重点观察第三次调用没有 tools/execute 和 tool/body，却仍有 tools/result。

结果接入的诊断对照
npm.cmd run day1 -- --bridge
此时第二次读取允许，得到 after；这只是结果接入桥接，不是新语义策略。

正式工作副本（不加桥接）
npm.cmd run day1 -- --working
第二次读取进入工具函数，返回 after。--bridge 仅用于原版诊断，不与 --working 组合。

结果接入与生命周期回归
npm.cmd test
当前共 38 条回归，包含原 18 条接入/生命周期用例及新增 20 条机制用例。
工作副本另外修复了调用关联和释放边界，后续对照需与“仅桥接”的效果分开记录。

后台等待案例
npm.cmd run day1 -- polling
npm.cmd run day1 -- polling --bridge
即使桥接结果，正常等待仍会被拦；子进程随后能够正常完成。

完整基线与 Python 摘要
npm.cmd run probe
npm.cmd run report
包含 19 条缺陷/控制轨迹，不能将其当作普遍准确率样本。

新增语义组件对照
npm.cmd run semantics
npm.cmd run report:semantics
运行五组共 30 条主对照与 3 条消融；工作副本语义开关默认关闭，实验 D 组开启全部。
结果见 docs/experiments/semantic-components-2026-11-03.md；简短讲解见 docs/面试速读.md。

来源检查与 API 可用性
npm.cmd run verify:vendor
npm.cmd run models
models 只访问官方 GET /models；使用本地 DEEPSEEK_API_KEY，不请求生成内容。
模型配置：config/model.json。当前目录的 .env.example 为变量模板，脚本不自动读取 .env。

目录
lessons/day1.mjs                 今天先读的入口，固定三个工具动作并打印事件。
lab/native-harness.mjs           真实 Cordis、ToolRuntime 与受控外围服务的装配。
lab/probe.mjs                    从前期调查迁入的 19 条回放与断言。
packages/loopguard/lib/          后续修改的插件工作副本。
tests/                          原生结果接入与调用生命周期回归。
vendor/dsh-agent-loop-guard-0.2.24/ 固定上游，作为原版基线，不在此开发。
fixtures/failing_test.py         有意失败的实际 Python 测试。
eval/report_baseline.py          Python 结果读取示例。
tools/check_deepseek.py          官方模型列表检查。
tools/dsh.ps1                    使用项目专用 DSH_HOME 的现有桌面 CLI 入口。
docs/day01-walkthrough.txt       今天的代码讲解、阅读顺序与手动练习。
docs/day02-result-integration.md 正式接入修复、设计取舍和里程碑事实摘要。
docs/项目执行计划.md             按实际阶段推进的开发流程、时间安排和实验计划。
docs/runtime-flow.mmd            关键事件流程图。
docs/progress.txt                工程验证和个人练习分别记录的进度。
versions.json                    固定版本、上游提交、完整性哈希。
THIRD_PARTY_NOTICES.txt          来源和 MIT 许可证说明。
results/                        本地运行产物，Git 忽略。

依赖恢复
Node 24、Python 3.12；在本目录运行：
npm.cmd ci --ignore-scripts --no-audit --no-fund
运行时的同版本 peer dependencies 由 package-lock.json 一并固定。
本地开发直接导入 packages/loopguard/lib，避免 Windows 符号链接权限要求。

完整 DSH 的状态
已找到桌面版 CLI，--version 为 0.2.1-rc.2，顶层 --help 正常。
在当前受限执行环境中，使用项目专用 DSH_HOME 启动 headless --help 时，
遇到 app.asar 的 realpath EPERM；记录见 results/environment/dsh-headless-help.txt。
这尚未证明完整 Agent 任务可运行，也不能据此断言本机外部终端会有同样问题。
后续使用 tools/dsh.ps1 从本机终端核实，再处理完整模型任务。

今天先跑默认 day1 并阅读对应事件，不需要一次读完全部上游代码。
