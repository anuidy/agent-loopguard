"""Publish aggregate component evidence without exporting local raw logs."""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=ROOT / "results/semantics/comparison.json")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = json.loads(args.input.read_text(encoding="utf-8"))
    cases = report["cases"]
    lines = ["# 工具语义机制：组件对照结果", "", f"记录日期：{report['measuredDate']}。", "",
             "真实 Cordis / ToolRuntime；工具动作由脚本控制，无模型自主决策。不是完整 Agent 任务评测。", "",
             "A 原版；B 仅结果桥接；B-safe 接入与生命周期修复；C 在 B-safe 上调宽重复阈值；D 开启三项语义机制。", "",
             "各场景工具请求上限一致（通常 8 次，读改再读及新错误对照 3 次）。数值是本次实际工具函数执行次数，括号为拒绝发生的请求序号。", "",
             "| 场景 | A | B | B-safe | C | D |", "|---|---|---|---|---|---|"]
    groups = [x["id"] for x in report["groups"]]
    scenarios = list(dict.fromkeys(x["scenario"] for x in cases if not x["ablation"]))
    labels = {
        "read-edit-read": "读→写→再读",
        "description-retries": "同命令仅换描述",
        "actual-failure-noise": "实际失败测试的时间噪声",
        "background-finish": "正常后台工作完成",
        "background-over-budget": "持续运行，最多允许4次等待",
        "new-error-then-pass": "新错误后成功",
    }
    for scenario in scenarios:
        cells = []
        for group in groups:
            summary = next(x["summary"] for x in cases if x["scenario"] == scenario and x["group"] == group)
            status = f"拒于 {summary['deniedCall']}" if summary["deniedCall"] else "完成" if summary["completed"] else "到达请求上限"
            cells.append(f"{summary['executions']}（{status}）")
        lines.append("| " + " | ".join([labels[scenario], *cells]) + " |")
    lines += ["", "## 消融", "", "| 关闭的机制 | 场景 | 执行次数 | 拒绝位置 |", "|---|---|---|---|"]
    for case in cases:
        if case["ablation"]:
            summary = case["summary"]
            lines.append(f"| {case['group']} | {labels[case['scenario']]} | {summary['executions']} | {summary['deniedCall'] or '未拒绝'} |")
    lines += ["", "## 口径与限制", "",
              "- 30 条主对照轨迹加 3 条消融。正反边界另由自动回归验证；这里不计算普遍准确率或成本节省百分比。",
              "- actual-failure-noise 实际运行 Python unittest；background 场景使用真实 Node 子进程。shell 工具定义、作业注册表接口与 Agent handle 是受控夹具。",
              "- 正常后台工作约 500ms 后独立完成；超预算场景的工作更长，脚本在记录拒绝后清理子进程，不能把清理误称为插件自动取消。",
              "- 去噪只支持明确的 unittest/项目失败夹具格式；未知输出保守保留，未建立通用日志语义理解。",
              "- 等待预算按会话/turn 计数，进展 epoch 不会补充等待预算；依赖工具遵守自身 timeout。频率或预算拒绝沿用本轮停止工具的反馈。",
              "- 完成状态通过可选作业注册表的非消费读取确认，允许一次最终收集；没有替代宿主 wait/完成通知，也未做完整通知唤醒端到端验证。",
              "- 没有模型生成、Token 消耗或完整任务成功率数据。", "",
              "复现：`npm.cmd run semantics`，然后 `npm.cmd run report:semantics`。", ""]
    markdown = "\n".join(lines)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(markdown, encoding="utf-8")
        aggregate = {key: report[key] for key in ["measuredDate", "scope", "controls", "runtime", "sourceHashes", "groups"]}
        aggregate["cases"] = [{key: case[key] for key in ["scenario", "group", "ablation", "config", "summary"]} for case in cases]
        args.output.with_suffix(".json").write_text(json.dumps(aggregate, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"Wrote {args.output}")
    print(markdown)


if __name__ == "__main__":
    main()
