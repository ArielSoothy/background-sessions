"""Regression checks for the directory's source-form and disclosure requirements."""
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


class DirectoryTests(unittest.TestCase):
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
