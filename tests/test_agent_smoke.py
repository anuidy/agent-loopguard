"""Acceptance-checker regressions; synthetic traces, no model/API calls."""
import json
from pathlib import Path
import tempfile
import unittest

from eval.run_agent_smoke import ROOT, validate


class AgentSmokeValidation(unittest.TestCase):
    def setUp(self):
        self.scratch = (ROOT / 'results/validator-tests').resolve()
        self.scratch.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=self.scratch)
        self.workspace = Path(self.temp.name) / 'workspace'
        self.workspace.mkdir()
        self.expected_counter = 7
        (self.workspace / 'input.json').write_text('{"counter": 7}', encoding='utf-8')
        (self.workspace / 'result.json').write_text('{"counter": 8}', encoding='utf-8')
        self.trace = [
            {'event': 'recorder_ready'},
            {'event': 'model_request'}, {'event': 'model_request'},
            {'event': 'guard_decision'}, {'event': 'turn_end', 'reason': 'completed'},
        ]
        for call_id, tool, file in [('1', 'read', 'input.json'),
                                    ('2', 'write', 'result.json'), ('3', 'read', 'result.json')]:
            self.trace += [
                {'event': 'tool_request', 'callId': call_id, 'tool': tool, 'filePath': file},
                {'event': 'tool_result', 'callId': call_id, 'isError': False},
            ]

    def tearDown(self):
        # Verify the recursive temporary cleanup stays inside our test directory.
        if not Path(self.temp.name).resolve().is_relative_to(self.scratch):
            raise RuntimeError('Refusing temporary cleanup outside the test workspace')
        self.temp.cleanup()

    def check(self):
        return validate(self.workspace, self.trace, [{'type': 'final', 'text': 'DONE'}], 0,
                        self.expected_counter)[0]

    def test_matching_artifact_and_native_chain_pass(self):
        self.assertTrue(all(self.check().values()))

    def test_exit_zero_and_done_text_do_not_replace_artifact(self):
        (self.workspace / 'result.json').unlink()
        self.assertFalse(self.check()['artifact_matches'])

    def test_boolean_is_not_an_integer_answer(self):
        self.expected_counter = 0
        (self.workspace / 'input.json').write_text('{"counter": 0}', encoding='utf-8')
        (self.workspace / 'result.json').write_text('{"counter": true}', encoding='utf-8')
        self.assertFalse(self.check()['artifact_matches'])

    def test_mutating_input_cannot_change_the_expected_answer(self):
        (self.workspace / 'input.json').write_text('{"counter": 8}', encoding='utf-8')
        (self.workspace / 'result.json').write_text('{"counter": 9}', encoding='utf-8')
        checks = self.check()
        self.assertFalse(checks['artifact_matches'])
        self.assertFalse(checks['input_unchanged'])

    def test_same_basename_outside_workspace_does_not_prove_tool_chain(self):
        for row in self.trace:
            if row.get('event') == 'tool_request':
                row['filePath'] = str(self.workspace.parent / row['filePath'])
        self.assertFalse(self.check()['native_read_write_read'])

    def test_failed_write_is_not_a_successful_mutation(self):
        for row in self.trace:
            if row.get('event') == 'tool_result' and row['callId'] == '2':
                row['isError'] = True
        self.assertFalse(self.check()['native_read_write_read'])

    def test_budget_hit_fails_even_with_a_correct_artifact(self):
        self.trace.append({'event': 'step_budget_reached'})
        self.assertFalse(self.check()['no_smoke_limit_hit'])


if __name__ == '__main__':
    unittest.main()
