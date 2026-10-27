"""Regression checks for the directory's source-form and disclosure requirements."""
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


class DirectoryTests(unittest.TestCase):
    def test_capability_source_has_no_wrapped_calls_or_chained_registrations(self):
        forbidden = (
            r'\(await \$\.', r'\(\$ as', r'\$\.[a-zA-Z]+\?\.', r'\$\[',
            r'\}\)\.catch\(', r'=>\s*[a-zA-Z]+\(\$',
            r'\{[a-zA-Z, ]+\}\s*=\s*await \$\.',
            r'\(await \w+\(\$[^\n]*\)\)[.!]',
        )
        for path in sorted((ROOT / 'hooks').glob('*.ts*')):
            for pattern in forbidden:
                self.assertNotRegex(path.read_text(), pattern, path.name)

    def test_helper_is_readable_python_with_explicit_extension(self):
        helper = ROOT / 'bin/sessions.py'
        self.assertTrue(helper.is_file())
        self.assertFalse((ROOT / 'bin/sessions').exists())
        self.assertTrue(helper.read_text().startswith('#!/usr/bin/env python3\n'))

    def test_capability_helpers_are_local_function_declarations(self):
        register = (ROOT / 'hooks/register.tsx').read_text()
        for path in (ROOT / 'hooks').glob('*.ts'):
            self.assertNotRegex(path.read_text(), r'\$[.:\[]', path.name)
        self.assertNotRegex(register, r'=\s*(?:async\s*)?\(\$')
        for name in re.findall(r'\b(\w+)\(\$\s*[,)]', register):
            if name != 'async':  # Direct on(...) callbacks are part of the supported source form.
                self.assertRegex(register, rf'(?m)^(?:export )?(?:async )?function {name}\(\$')
        for name in ('readOnly', 'configRoot', 'dataDir', 'writeObject', 'enabled',
                     'helperFailed', 'runHelper', 'readMarker', 'debug', 'pruneStore',
                     'refresh', 'reportUsage', 'rename', 'sync', 'schedule',
                     'restoreDone', 'markDone', 'applyDone'):
            self.assertRegex(register, rf'(?m)^(?:export )?(?:async )?function {name}\(\$')

    def test_command_hooks_never_rewrite_events(self):
        register = (ROOT / 'hooks/register.tsx').read_text()
        self.assertNotRegex(register, r'next\(\s*\{')
        self.assertIn('safeName(e.args) !== e.args', register)

    def test_manifests_use_new_identity(self):
        plugin = json.loads((ROOT / '.claude-plugin/plugin.json').read_text())
        marketplace = json.loads((ROOT / '.claude-plugin/marketplace.json').read_text())
        self.assertEqual(plugin['name'], 'background-sessions')
        self.assertEqual(plugin['version'], '0.4.0')
        self.assertEqual(plugin['homepage'], 'https://github.com/ArielSoothy/background-sessions')
        self.assertEqual(plugin['repository'], plugin['homepage'])
        self.assertEqual(marketplace['name'], plugin['name'])
        self.assertEqual(marketplace['plugins'][0]['name'], plugin['name'])
