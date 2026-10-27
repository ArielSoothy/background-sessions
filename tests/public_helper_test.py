import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
loader = importlib.machinery.SourceFileLoader('public_sessions', str(ROOT / 'bin/sessions'))
spec = importlib.util.spec_from_loader(loader.name, loader)
sessions = importlib.util.module_from_spec(spec)
loader.exec_module(sessions)


class PublicHelperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.jobs = self.home / '.claude/jobs'
        self.data = self.home / '.claude/session-board'
        self.data.mkdir(parents=True)
        self.jobs.mkdir(parents=True)

    def put(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))

    def job(self, sid='session-1', **values):
        self.put(self.jobs / sid / 'state.json', dict(sessionId=sid, name='build', state='done', **values))

    def collect(self, writable=False):
        return sessions.collect(self.jobs, None, self.data, writable, home=self.home)

    def test_longest_cwd_root_and_origin_fallback(self):
        self.put(self.data / 'projects.json', {'roots': ['~/Projects/alpha', '~/Projects/alpha/tools'], 'projects': {'tools': {'title': 'Tools', 'short': 'Tool'}}, 'merge': {}})
        self.job(cwd=str(self.home / 'Projects/alpha/tools/lib'))
        row = self.collect()['rows'][0]
        self.assertEqual((row['projectId'], row['projectShort'], row['projectSource']), ('tools', 'Tool', 'cwd'))
        self.job(cwd=None, originCwd=str(self.home / 'Projects/alpha/src'))
        self.assertEqual(self.collect()['rows'][0]['projectId'], 'alpha')

    def test_missing_jobs_is_empty(self):
        self.jobs.rmdir()
        self.assertEqual(self.collect()['rows'], [])
        self.assertEqual(self.collect()['errors'], [])

    def test_missing_catalog_is_silent(self):
        self.put(self.data / 'projects.json', {'catalog': '~/absent.json'})
        self.assertEqual(self.collect()['errors'], [])

    def test_malformed_config_and_job_are_tolerated(self):
        self.job(cwd=str(self.home / 'work'))
        for config in ({'projects': None, 'roots': None, 'merge': None}, [], None, {'catalog': 9}):
            self.put(self.data / 'projects.json', config)
            self.assertEqual(self.collect()['rows'][0]['projectId'], 'work')
        (self.data / 'projects.json').write_text('{')
        self.assertEqual(len(self.collect()['rows']), 1)
        self.put(self.jobs / 'broken/state.json', [])
        self.assertEqual(len(self.collect()['rows']), 1)

    def test_collect_never_changes_host_jobs(self):
        self.job(cwd=str(self.home / 'Projects/alpha'))
        self.job('stopped', cwd=str(self.home / 'Projects/beta'))
        state = self.jobs / 'stopped/state.json'
        self.put(state, dict(sessionId='stopped', name='build', state='stopped'))
        before = {str(p.relative_to(self.jobs)): (p.read_bytes(), p.stat().st_mtime_ns) for p in self.jobs.rglob('*') if p.is_file()}
        self.collect(True)
        after = {str(p.relative_to(self.jobs)): (p.read_bytes(), p.stat().st_mtime_ns) for p in self.jobs.rglob('*') if p.is_file()}
        self.assertEqual(before, after)
        self.assertTrue(next(r for r in self.collect()['rows'] if r['id'] == 'stopped')['closed'])

    def test_links_special_and_oversize_files_are_skipped(self):
        self.job()
        outside = self.home / 'outside.json'
        self.put(outside, {'sessionId': 'outside'})
        (self.jobs / 'linked').mkdir()
        (self.jobs / 'linked/state.json').symlink_to(outside)
        (self.jobs / 'pipe').mkdir()
        os.mkfifo(self.jobs / 'pipe/state.json')
        (self.jobs / 'large').mkdir()
        (self.jobs / 'large/state.json').write_bytes(b' ' * (1024 * 1024 + 1))
        self.assertEqual([r['id'] for r in self.collect()['rows']], ['session-1'])

    def test_only_mod_reports_supply_usage(self):
        self.job(model='ignored', tokens=9999)
        row = self.collect()['rows'][0]
        self.assertEqual((row['model'], row['tokens']), ('', None))
        self.put(self.data / 'usage/session-1.json', {'sessionId': 'session-1', 'model': 'example-model', 'tokens': 20, 'window': 100, 'percent': 20})
        self.assertEqual(self.collect()['rows'][0]['tokens'], 20)

    def test_pruning_and_read_only(self):
        self.job()
        for kind in ('usage', 'done'):
            self.put(self.data / kind / 'gone.json', {})
            self.put(self.data / kind / 'session-1.json', {'sessionId': 'session-1'})
        self.collect(False)
        self.assertTrue((self.data / 'done/gone.json').exists())
        self.collect(True)
        for kind in ('usage', 'done'):
            self.assertFalse((self.data / kind / 'gone.json').exists())
            self.assertTrue((self.data / kind / 'session-1.json').exists())

    def test_default_discovery_git_and_basename(self):
        (self.home / 'Projects/alpha').mkdir(parents=True)
        self.job(cwd=str(self.home / 'Projects/alpha/src'))
        self.assertEqual(self.collect()['rows'][0]['projectId'], 'alpha')
        (self.home / 'work/beta/.git').mkdir(parents=True)
        self.job(cwd=str(self.home / 'work/beta/src'))
        self.assertEqual(self.collect()['rows'][0]['projectId'], 'beta')
        self.job(cwd=str(self.home / 'work/leaf'))
        self.assertEqual(self.collect()['rows'][0]['projectId'], 'leaf')

    def test_large_numbers_and_null_catalog_are_safe(self):
        self.job(cwd=str(self.home / 'alpha'), inFlight={'tasks': 10**1000})
        self.put(self.data / 'projects.json', {'catalog': '~/catalog.json'})
        self.put(self.home / 'catalog.json', {'projects': None})
        self.assertIsNone(self.collect()['rows'][0]['tasks'])

    def test_abbreviated_job_preserves_full_session_reports(self):
        sid = '12345678-aaaa-bbbb-cccc-123456789abc'
        self.put(self.jobs / '12345678/state.json', {'sessionId': sid})
        for kind in ('usage', 'done'):
            self.put(self.data / kind / (sid + '.json'), {'sessionId': sid})
        self.collect(True)
        self.assertTrue((self.data / 'usage' / (sid + '.json')).exists())
        self.assertTrue((self.data / 'done' / (sid + '.json')).exists())

    def test_linked_plugin_directory_is_never_pruned(self):
        outside = self.home / 'elsewhere'
        outside.mkdir()
        self.put(outside / 'gone.json', {})
        (self.data / 'usage').symlink_to(outside)
        self.collect(True)
        self.assertTrue((outside / 'gone.json').exists())

    def test_file_parent_swap_cannot_redirect_an_open(self):
        target = self.jobs / 'session-1/state.json'
        self.job()
        outside = self.home / 'elsewhere'
        self.put(outside / 'state.json', {'sessionId': 'outside'})
        original = sessions.os.open
        swapped = False
        def swap(path, flags, *args, **kwargs):
            nonlocal swapped
            # Swap the parent exactly when the final metadata file is opened.
            if str(path).endswith('state.json') and not swapped:
                swapped = True
                target.parent.rename(self.jobs / 'held')
                target.parent.symlink_to(outside, target_is_directory=True)
            return original(path, flags, *args, **kwargs)
        from unittest.mock import patch
        with patch.object(sessions.os, 'open', side_effect=swap):
            value = sessions.read_json(target, anchor=self.jobs)
        self.assertNotEqual(value, {'sessionId': 'outside'})

    def test_helper_record_writes_are_atomic_and_plugin_only(self):
        root = self.home / '.claude'
        self.assertTrue(sessions.write_record(root, 'usage', 'session-1', json.dumps({'sessionId': 'session-1', 'model': 'example-model', 'tokens': 20, 'window': 100, 'percent': 20, 'at': 1, 'unexpected': 'discard'})))
        value = json.loads((self.data / 'usage/session-1.json').read_text())
        self.assertNotIn('unexpected', value)
        self.assertEqual(value['tokens'], 20)
        self.assertTrue(sessions.write_record(root, 'done', 'session-1', '{"reason":"done-command","at":1}'))
        self.assertTrue(sessions.write_record(root, 'done', 'session-1', '{"cleared":true,"at":2}'))
        self.assertTrue(json.loads((self.data / 'done/session-1.json').read_text())['cleared'])
        self.assertEqual(list(self.jobs.iterdir()), [])
        self.assertEqual(list(self.data.rglob('*.tmp')), [])

    def test_write_refuses_links_special_files_and_invalid_schema(self):
        root = self.home / '.claude'
        outside = self.home / 'elsewhere'
        outside.mkdir()
        (self.data / 'usage').symlink_to(outside)
        payload = '{"sessionId":"s","model":"example-model","at":1}'
        self.assertFalse(sessions.write_record(root, 'usage', 's', payload))
        self.assertEqual(list(outside.iterdir()), [])
        (self.data / 'usage').unlink()
        (self.data / 'done').mkdir()
        os.mkfifo(self.data / 'done/s.json')
        self.assertFalse(sessions.write_record(root, 'done', 's', '{"reason":"done-command","at":1}'))
        self.assertFalse(sessions.write_record(root, 'done', '../bad', '{}'))
        self.assertFalse(sessions.write_record(root, 'jobs', 's', '{}'))
        self.assertFalse(sessions.write_record(root, 'usage', 's', '[]'))

    def test_clear_absent_marker_creates_no_file(self):
        self.assertTrue(sessions.write_record(self.home / 'new-root', 'done', 's', '{"cleared":true,"at":1}'))
        self.assertFalse((self.home / 'new-root').exists())

    def test_read_only_is_enforced_before_record_dispatch(self):
        env = {'PATH': os.getenv('PATH', os.defpath), 'HOME': str(self.home)}
        argv = ['python3', str(ROOT / 'bin/sessions'), '--read-only', '--write-record', 'done', 's', '{"reason":"done-command","at":1}']
        result = subprocess.run(argv, env=env, capture_output=True, text=True, check=True)
        self.assertFalse(json.loads(result.stdout)['written'])
        self.assertFalse((self.data / 'done').exists())
        env['SESSION_BOARD_READ_ONLY'] = '1'
        argv.remove('--read-only')
        result = subprocess.run(argv, env=env, capture_output=True, text=True, check=True)
        self.assertFalse(json.loads(result.stdout)['written'])
        self.assertFalse((self.data / 'done').exists())

    def test_prune_parent_swap_cannot_delete_elsewhere(self):
        usage = self.data / 'usage'
        self.put(usage / 'gone.json', {})
        outside = self.home / 'elsewhere'
        self.put(outside / 'gone.json', {'keep': True})
        original = sessions.os.unlink
        swapped = False
        def swap(path, *args, **kwargs):
            nonlocal swapped
            if str(path).endswith('gone.json') and not swapped:
                swapped = True
                usage.rename(self.data / 'held')
                usage.symlink_to(outside, target_is_directory=True)
            return original(path, *args, **kwargs)
        from unittest.mock import patch
        with patch.object(sessions.os, 'unlink', side_effect=swap):
            self.collect(True)
        self.assertTrue((outside / 'gone.json').exists())

    def test_catalog_roots_merges_and_boundary_matching(self):
        self.put(self.home / 'catalog.json', {'projects': [{'id': 'alpha', 'display_title': 'Alpha — tools', 'location': {'local_path': '~/Projects/alpha'}}]})
        self.put(self.data / 'projects.json', {'catalog': '~/catalog.json', 'roots': ['~/Projects/alpha-copy'], 'projects': {'alpha': {'short': 'A'}}, 'merge': {'alpha-copy*': 'alpha'}})
        self.job(cwd=str(self.home / 'Projects/alpha-copy/src'))
        row = self.collect()['rows'][0]
        self.assertEqual((row['projectId'], row['projectShort']), ('alpha', 'A'))
        self.job(cwd=str(self.home / 'Projects/alphabet/src'))
        self.assertEqual(self.collect()['rows'][0]['projectId'], 'src')

    def test_unreadable_job_does_not_drive_orphan_cleanup(self):
        self.put(self.data / 'usage/long-session-id.json', {})
        self.put(self.jobs / 'long/state.json', [])
        board = self.collect(True)
        self.assertFalse(board['inventoryComplete'])
        self.assertTrue((self.data / 'usage/long-session-id.json').exists())

    def test_cli_end_to_end_records_and_collection_leave_jobs_unchanged(self):
        root = self.home / '.claude'
        self.job(cwd=str(self.home / 'Projects/alpha'))
        before = (self.jobs / 'session-1/state.json').read_bytes()
        env = {'PATH': os.getenv('PATH', os.defpath), 'HOME': str(self.home)}
        def run(*args):
            result = subprocess.run(['python3', str(ROOT / 'bin/sessions'), *args], env=env, capture_output=True, text=True, check=True)
            return json.loads(result.stdout)
        self.assertTrue(run('--write-record', 'usage', 'session-1', '{"sessionId":"session-1","model":"example-model","tokens":26,"window":100,"percent":26,"at":1}')['written'])
        self.assertTrue(run('--write-record', 'done', 'session-1', '{"reason":"done-command","at":1}')['written'])
        row = run('--json')['rows'][0]
        self.assertEqual((row['status'], row['model'], row['tokens']), ('closed', 'example-model', 26))
        self.assertTrue(run('--write-record', 'done', 'session-1', '{"cleared":true,"at":2}')['written'])
        self.assertEqual(run('--json')['rows'][0]['status'], 'yours')
        self.assertEqual((self.jobs / 'session-1/state.json').read_bytes(), before)
        self.assertEqual(sorted(p.name for p in (self.jobs / 'session-1').iterdir()), ['state.json'])

    def test_cli_config_dir_and_missing_home(self):
        custom = self.home / 'custom'
        self.put(custom / 'jobs/s/state.json', {'sessionId': 's', 'cwd': str(self.home / 'alpha')})
        env = {'PATH': os.getenv('PATH', os.defpath), 'HOME': str(self.home), 'CLAUDE_CONFIG_DIR': str(custom)}
        result = subprocess.run(['python3', str(ROOT / 'bin/sessions'), '--json', '--read-only'], env=env, capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)['rows'][0]['id'], 's')
        env.pop('HOME')
        result = subprocess.run(['python3', str(ROOT / 'bin/sessions'), '--json'], env=env, capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)['rows'][0]['id'], 's')

    def test_symlinked_config_root_and_ancestor(self):
        self.job()
        alias = self.home / 'config-link'
        alias.symlink_to(self.home / '.claude', target_is_directory=True)
        self.assertEqual(sessions.collect(alias / 'jobs', None, alias / 'session-board', home=self.home)['rows'][0]['id'], 'session-1')
        self.assertTrue(sessions.write_record(alias, 'done', 'session-1', '{"at":1,"reason":"done-command"}'))
        ancestor = self.home / 'home-link'
        ancestor.symlink_to(self.home, target_is_directory=True)
        self.assertEqual(sessions.collect(ancestor / '.claude/jobs', None, ancestor / '.claude/session-board', home=ancestor)['rows'][0]['id'], 'session-1')

    def test_missing_root_is_not_created(self):
        root = self.home / 'missing/nested'
        self.assertFalse(sessions.write_record(root, 'done', 's', '{"at":1,"reason":"done-command"}'))
        self.assertFalse(root.parent.exists())

    def test_own_records_and_temporary_cleanup(self):
        for kind in ('usage', 'done'):
            self.put(self.data / kind / 'foreground.json', {})
            (self.data / kind / '.stray.tmp').write_text('partial')
        (self.data / '.stray.tmp').write_text('partial')
        sessions.collect(self.jobs, None, self.data, True, home=self.home, own_session='foreground')
        for kind in ('usage', 'done'):
            self.assertTrue((self.data / kind / 'foreground.json').exists())
            self.assertFalse((self.data / kind / '.stray.tmp').exists())
        self.assertFalse((self.data / '.stray.tmp').exists())

    def test_unreadable_jobs_reports_one_error(self):
        from unittest.mock import patch
        original = sessions.os.listdir
        def deny(path):
            if isinstance(path, int) and os.fstat(path).st_ino == self.jobs.stat().st_ino:
                raise PermissionError('denied')
            return original(path)
        with patch.object(sessions.os, 'listdir', side_effect=deny):
            board = self.collect(True)
        self.assertEqual(board['errors'], ['Jobs directory unreadable.'])
        self.assertFalse(board['inventoryComplete'])

    def test_realpath_matching_and_git_home_boundary(self):
        root = self.home / 'actual'
        root.mkdir()
        alias = self.home / 'alias'
        alias.symlink_to(root, target_is_directory=True)
        projects = [{'projectId': 'chosen', 'projectName': 'Chosen', 'projectShort': 'C', 'roots': [str(alias)]}]
        self.assertEqual(sessions.project_for_cwd(str(root / 'src'), projects, self.home)['projectId'], 'chosen')
        from unittest.mock import patch
        original = Path.lstat
        def probe(path, *args, **kwargs):
            if path == self.home.parent / '.git':
                raise AssertionError('walked above home')
            return original(path, *args, **kwargs)
        with patch.object(Path, 'lstat', probe):
            self.assertEqual(sessions.project_for_cwd(str(self.home / 'work/leaf'), [], self.home)['projectId'], 'leaf')

    def test_ascii_stdout_json(self):
        self.job(cwd=str(self.home / '日本語'))
        env = {'PATH': os.getenv('PATH', os.defpath), 'HOME': str(self.home), 'PYTHONIOENCODING': 'ascii'}
        result = subprocess.run(['python3', str(ROOT / 'bin/sessions'), '--json', '--read-only'], env=env, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['rows'][0]['projectName'], '日本語')

    def test_narrow_table_preserves_state_before_optional_columns(self):
        self.job(cwd=str(self.home / 'Alpha'))
        board = self.collect()
        board['rows'][0]['name'] = 'n' * 100
        line = sessions.render_table(board, 45, False).splitlines()[-1]
        self.assertIn('! YOU', line)
        self.assertIn('n' * 16, line)
        self.assertLessEqual(sessions.display_width(line), 45)

    def test_jobs_and_plugin_data_can_be_trusted_symlink_roots(self):
        self.job()
        jobs_link = self.home / 'jobs-link'
        data_link = self.home / 'data-link'
        jobs_link.symlink_to(self.jobs, target_is_directory=True)
        data_link.symlink_to(self.data, target_is_directory=True)
        board = sessions.collect(jobs_link, None, data_link, home=self.home)
        self.assertEqual(board['rows'][0]['id'], 'session-1')
        self.data.rename(self.home / 'plugin-data')
        self.data.symlink_to(self.home / 'plugin-data', target_is_directory=True)
        self.assertTrue(sessions.write_record(self.home / '.claude', 'done', 'session-1', '{"at":1,"reason":"done-command"}'))

    def test_unused_state_fields_never_enter_output(self):
        self.job(prompt='private-prompt', intent='private-intent', statusDetail='private-detail', inFlight={'tasks': 2, 'detail': 'private-flight'})
        output = json.dumps(self.collect())
        for value in ('private-prompt', 'private-intent', 'private-detail', 'private-flight'):
            self.assertNotIn(value, output)
        self.assertEqual(self.collect()['rows'][0]['tasks'], 2)


if __name__ == '__main__':
    unittest.main()
