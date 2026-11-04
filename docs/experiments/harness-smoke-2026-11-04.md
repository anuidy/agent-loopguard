# Harness 安装与真实模型任务验证

记录截止日期：2026-11-04。

使用官方 headless Agent、官方文件工具和 DeepSeek 模型；动作由模型选择，验收由 Python 检查。测试用观察插件只记录轨迹和限制资源，不提供工具结果。

| 尝试 | 结果/原因 | 模型请求 | 工具请求 | 工具错误 | 秒 |
|---|---|---|---|---|---|
| 1 | legacy-stop-word | 2 | 1 | 1 | 3.36 |
| 2 | outer-filesystem-atomic-create | 4 | 3 | 2 | 5.609 |
| 3 | passed | 4 | 3 | 0 | 6.062 |
| 4 | passed | 4 | 3 | 0 | 7.5 |

## 验收与解释

- 成功实例：读取输入、将counter加一写入结果，再读取结果。检查产物、原生工具顺序、插件决策、正常终态以及资源限制；最新验收还确认输入未修改，期望值来自运行前的固定参数。
- 失败尝试也保留：首轮提示词中的answer触发上游保留的停止词规则；随后外层沙箱阻止原生文件工具的原子创建。退出码0和最终文本都不能替代产物验收。
- 成功运行使用正常外层执行权限，DSH内部仍保持workspace-write，并额外限制为两个任务文件；未改成danger-full-access。
- 这些是同一类小任务的运行与排障记录，提示词措辞/外层执行环境曾改变，不能据此计算任务成功率或策略收益。
- 该任务实际调用read/write，未触发shell和job_output专属适配；三项策略的效果依据仍是单独的组件对照。
- Token聚合采用提供方usage；inputTokens为未缓存输入，cacheReadTokens/cacheWriteTokens另列。首轮观察器尚未正确采集usage，因此其totalTokens为null，不回填。
- 原始轨迹、提示词、会话文件及模型输出保留本地results/与.runtime/；公开JSON仅包含聚合证据。

复现：`npm.cmd run profile:prepare`，再运行`npm.cmd run smoke:agent`；真实调用模型API。普通测试`npm.cmd test`不访问模型。
