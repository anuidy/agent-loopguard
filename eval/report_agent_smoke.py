"""Summarize local model-run evidence without exporting prompts or raw logs."""
import argparse
import json
from pathlib import Path
import sys

from eval.run_agent_smoke import ROOT, parse_jsonl


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    runs = []
    for path in sorted((ROOT / 'results/agent-smoke').glob('*/report.json')):
        report = json.loads(path.read_text(encoding='utf-8'))
        trace_path = path.parent / 'trace.jsonl'
        trace = parse_jsonl(trace_path.read_text(encoding='utf-8')) if trace_path.exists() else []
        stdout = (path.parent / 'stdout.jsonl').read_text(encoding='utf-8')
        cause = 'passed' if report['passed'] else (
            'legacy-stop-word' if any(r.get('code') == 'LOOP_GUARD_STOP' for r in trace)
            else 'outer-filesystem-atomic-create' if 'EPERM' in stdout else 'needs-analysis')
        usage = report['usageRecords']
        totals = {key: sum(row.get(key, 0) for row in usage) if usage else None for key in [
            'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']}
        totals['totalTokens'] = sum(row['totalTokens'] for row in usage) if usage and all('totalTokens' in row for row in usage) else None
        record = {key: report.get(key) for key in ['passed', 'exitCode', 'elapsedSeconds',
            'modelSteps', 'toolRequests', 'toolErrors', 'guardDecisions', 'hostNodeVersion', 'checks']}
        record.update(cause=cause, tokens=totals,
            nativeTools=[r['tool'] for r in trace if r.get('event') == 'tool_request'])
        for file, key in [('input.json', 'observedInput'), ('result.json', 'observedResult')]:
            artifact = path.parent / 'workspace' / file
            record[key] = json.loads(artifact.read_text(encoding='utf-8')) if artifact.exists() else None
        runs.append(record)
    last_date = sorted((ROOT / 'results/agent-smoke').glob('*/report.json'))[-1].parent.name[:8] if runs else ''
    measured_date = f'{last_date[:4]}-{last_date[4:6]}-{last_date[6:8]}' if last_date else 'no-runs'
    summary = {
        'measuredDate': measured_date, 'scope': 'Installation and one task family smoke; not a strategy benchmark.',
        'provider': 'deepseek-official', 'model': 'deepseek-flash', 'profile': 'loopguard',
        'plugin': '@agent-loopguard/plugin@0.1.0-dev.1',
        'dshCli': '0.2.1-rc.2', 'runs': runs,
    }
    lines = ['# Harness 安装与真实模型任务验证', '', f'记录截止日期：{measured_date}。', '',
        '使用官方 headless Agent、官方文件工具和 DeepSeek 模型；动作由模型选择，验收由 Python 检查。测试用观察插件只记录轨迹和限制资源，不提供工具结果。', '',
        '| 尝试 | 结果/原因 | 模型请求 | 工具请求 | 工具错误 | 秒 |', '|---|---|---|---|---|---|']
    for i, run in enumerate(runs, 1):
        lines.append(f"| {i} | {run['cause']} | {run['modelSteps']} | {run['toolRequests']} | {run['toolErrors']} | {run['elapsedSeconds']} |")
    lines += ['', '## 验收与解释', '',
        '- 成功实例：读取输入、将counter加一写入结果，再读取结果。检查产物、原生工具顺序、插件决策、正常终态以及资源限制；最新验收还确认输入未修改，期望值来自运行前的固定参数。',
        '- 失败尝试也保留：首轮提示词中的answer触发上游保留的停止词规则；随后外层沙箱阻止原生文件工具的原子创建。退出码0和最终文本都不能替代产物验收。',
        '- 成功运行使用正常外层执行权限，DSH内部仍保持workspace-write，并额外限制为两个任务文件；未改成danger-full-access。',
        '- 这些是同一类小任务的运行与排障记录，提示词措辞/外层执行环境曾改变，不能据此计算任务成功率或策略收益。',
        '- 该任务实际调用read/write，未触发shell和job_output专属适配；三项策略的效果依据仍是单独的组件对照。',
        '- Token聚合采用提供方usage；inputTokens为未缓存输入，cacheReadTokens/cacheWriteTokens另列。首轮观察器尚未正确采集usage，因此其totalTokens为null，不回填。',
        '- 原始轨迹、提示词、会话文件及模型输出保留本地results/与.runtime/；公开JSON仅包含聚合证据。', '',
        '复现：`npm.cmd run profile:prepare`，再运行`npm.cmd run smoke:agent`；真实调用模型API。普通测试`npm.cmd test`不访问模型。', '']
    text = '\n'.join(lines)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text, encoding='utf-8')
        args.output.with_suffix('.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding='utf-8')
    print(text)


if __name__ == '__main__':
    main()
