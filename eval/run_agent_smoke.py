"""Run one bounded real Harness/model task and independently verify its artifact."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]


def parse_jsonl(text):
    records = []
    for line in text.splitlines():
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                records.append(value)
        except json.JSONDecodeError:
            pass
    return records


def validate(workspace, trace, stdout_events, exit_code, expected_counter):
    results = {r.get('callId'): r for r in trace if r.get('event') == 'tool_result'}
    successful = []
    for row in trace:
        if row.get('event') != 'tool_request' or results.get(row.get('callId'), {}).get('isError') is not False:
            continue
        target = Path(row.get('filePath', ''))
        if not target.is_absolute():
            target = workspace / target
        try:
            path = target.resolve().relative_to(workspace.resolve()).as_posix()
        except ValueError:
            continue
        successful.append((row['tool'], path))
    wanted = [('read', 'input.json'), ('write', 'result.json'), ('read', 'result.json')]
    position = 0
    for item in successful:
        if position < len(wanted) and item == wanted[position]:
            position += 1
    try:
        actual = json.loads((workspace / 'result.json').read_text(encoding='utf-8'))
        artifact_ok = (isinstance(actual, dict) and set(actual) == {'counter'}
                       and type(actual['counter']) is int
                       and actual['counter'] == expected_counter + 1)
    except (OSError, ValueError, KeyError):
        artifact_ok = False
    try:
        source = json.loads((workspace / 'input.json').read_text(encoding='utf-8'))
        input_unchanged = source == {'counter': expected_counter} and type(source['counter']) is int
    except (OSError, ValueError, KeyError, TypeError):
        input_unchanged = False
    guard_events = [r for r in trace if r.get('event') == 'guard_decision']
    usage = [r['usage'] for r in trace if r.get('event') == 'model_usage']
    checks = {
        'process_exited_zero': exit_code == 0,
        'artifact_matches': artifact_ok,
        'input_unchanged': input_unchanged,
        'native_read_write_read': position == len(wanted),
        'loopguard_observed_real_calls': len(guard_events) > 0,
        'recorder_loaded': any(r.get('event') == 'recorder_ready' for r in trace),
        'model_used_multiple_steps': sum(r.get('event') == 'model_request' for r in trace) >= 2,
        'headless_final_event': any(r.get('type') == 'final' for r in stdout_events),
        'turn_completed': any(r.get('event') == 'turn_end' and r.get('reason') == 'completed' for r in trace),
        'no_smoke_limit_hit': not any(r.get('event') in ['step_budget_reached', 'smoke_denial'] for r in trace),
    }
    return checks, {
        'modelSteps': sum(r.get('event') == 'model_request' for r in trace),
        'toolRequests': sum(r.get('event') == 'tool_request' for r in trace),
        'toolErrors': sum(r.get('event') == 'tool_result' and r.get('isError') is True for r in trace),
        'guardDecisions': len(guard_events), 'usageRecords': usage,
        'hostNodeVersion': next((r.get('nodeVersion') for r in trace if r.get('event') == 'recorder_ready'), None),
    }


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--timeout', type=int, default=120)
    parser.add_argument('--counter', type=int, default=41)
    args = parser.parse_args()
    if os.name != 'nt':
        print('This smoke entry currently uses the Windows desktop CLI; see docs/harness-integration.md.')
        return 2
    if not 10 <= args.timeout <= 180:
        parser.error('--timeout must be 10..180 seconds')
    if not os.environ.get('DEEPSEEK_API_KEY'):
        print('DEEPSEEK_API_KEY is absent; no model request made.')
        return 2
    profile = ROOT / '.runtime/dsh-home/profiles/loopguard'
    if not (profile / 'node_modules/@agent-loopguard/plugin/package.json').is_file():
        print('Run npm.cmd run profile:prepare first.')
        return 2
    stamp = datetime.now(timezone(timedelta(hours=8))).strftime('%Y%m%d-%H%M%S')
    run_dir = ROOT / 'results/agent-smoke' / f'{stamp}-{uuid.uuid4().hex[:6]}'
    workspace = run_dir / 'workspace'
    workspace.mkdir(parents=True)
    (workspace / 'input.json').write_text(json.dumps({'counter': args.counter}), encoding='utf-8')
    trace_path = run_dir / 'trace.jsonl'
    overlay = run_dir / 'recorder.patch.yml'
    overlay.write_text('- insert:\n    - id: loopguard-smoke-recorder\n      name: '
        + json.dumps((ROOT / 'lab/smoke-recorder.mjs').as_uri())
        + '\n      config:\n        tracePath: ' + json.dumps(str(trace_path))
        + '\n        maxSteps: 6\n        maxToolCalls: 8\n', encoding='utf-8')
    task = ('Read input.json, increment its integer counter by one, and create result.json '
            'with exactly one key counter holding the new integer. Then read result.json to '
            'verify it. Use only the native read/write/edit file tools, never shell, web, '
            'subagents or other tools. Work only on these two files. Finally reply DONE.')
    command = ['powershell.exe', '-NoProfile', '-File', str(ROOT / 'tools/dsh.ps1'),
               '--profile', 'loopguard', '--patch', str(overlay), '--json', task]
    env = dict(os.environ)
    env['DSH_TELEMETRY_DISABLED'] = '1'
    creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    started = time.monotonic()
    proc = subprocess.Popen(command, cwd=workspace, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, creationflags=creation_flags)
    timed_out = False
    try:
        stdout, stderr = proc.communicate(timeout=args.timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        # Stop only the process tree this runner created, never other DSH runs.
        if os.name == 'nt':
            subprocess.run(['taskkill', '/PID', str(proc.pid), '/T', '/F'],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            proc.send_signal(signal.SIGTERM)
        stdout, stderr = proc.communicate(timeout=10)
    secret = env['DEEPSEEK_API_KEY']
    decode = lambda data: data.decode('utf-8', errors='replace').replace(secret, '[redacted]')
    stdout, stderr = decode(stdout), decode(stderr)
    (run_dir / 'stdout.jsonl').write_text(stdout, encoding='utf-8')
    (run_dir / 'stderr.txt').write_text(stderr, encoding='utf-8')
    trace = parse_jsonl(trace_path.read_text(encoding='utf-8')) if trace_path.exists() else []
    checks, metrics = validate(workspace, trace, parse_jsonl(stdout), proc.returncode, args.counter)
    checks['within_wall_timeout'] = not timed_out
    report = {
        'scope': 'One real DSH headless/model task, not a benchmark or strategy benefit estimate.',
        'provider': 'deepseek-official', 'model': 'deepseek-flash',
        'profile': 'loopguard', 'passed': all(checks.values()), 'checks': checks,
        'taskInput': {'counter': args.counter}, 'expectedArtifact': {'counter': args.counter + 1},
        'exitCode': proc.returncode, 'elapsedSeconds': round(time.monotonic() - started, 3),
        **metrics,
    }
    (run_dir / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    latest = ROOT / 'results/agent-smoke/latest.json'
    latest.write_text(json.dumps({'runDir': str(run_dir), **report}, indent=2), encoding='utf-8')
    print(json.dumps({'report': str(run_dir / 'report.json'), **report}, ensure_ascii=False))
    if not report['passed']:
        print('Integration check failed; inspect the saved redacted logs.')
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
