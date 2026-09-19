import types
import unittest
from unittest.mock import patch

import install


SETTINGS = {
    "branchPicker": True,
    "shortPlaceholder": True,
    "commitAndPush": True,
    "branchCleanup": True,
    "autocompleteToggle": True,
    "hideOutgoingSyncCount": True,
    "defaultBranch": "main",
    "remote": "origin",
}


def workbench_fixture():
    return "".join(
        [
            'cmd=svc("commandService")',
            'notify=svc("notificationService")',
            'config=svc("configurationService")',
            'function watch(s,o=source.ofCaller()){return new first(new second(void 0,void 0,s),s,void 0,o)}',
            'this.disposables.add(this.toolbar)}static{this.ValidationTimeouts=',
            'this.inputEditor.setModel(void 0),this.model=void 0;return}'
            'let e=o.repository.provider.inputBoxTextModel;',
            'this.toolbar.setInput(o),this.model={input:o,textModel:e}}get selections()',
            't=new size(this.element.clientWidth-e,o);if(t.width<0)',
        ]
    )


class TransformTests(unittest.TestCase):
    def test_install_injects_valid_settings_line(self):
        js, css = install.transform(workbench_fixture(), "base-css", settings=SETTINGS)

        self.assertIn(
            'const scmToolkitSettings = '
            '{"branchPicker":true,"shortPlaceholder":true,"commitAndPush":true,'
            '"branchCleanup":true,"autocompleteToggle":true,'
            '"hideOutgoingSyncCount":true,'
            '"defaultBranch":"main","remote":"origin"};\n',
            js,
        )
        self.assertIn("editor.inlineSuggest.enabled", js)
        self.assertIn("scm-toolkit-autocomplete", css)
        self.assertEqual(js.count(install.START), 1)
        self.assertEqual(js.count(install.END), 1)
        self.assertEqual(css.count(install.START), 1)
        self.assertEqual(css.count(install.END), 1)

    def test_install_and_remove_round_trip(self):
        original_js = workbench_fixture()
        original_css = "base-css"

        patched = install.transform(original_js, original_css, settings=SETTINGS)
        restored = install.transform(*patched, remove=True, settings=SETTINGS)

        self.assertEqual(restored, (original_js, original_css))

    def test_reinstall_replaces_configuration_without_duplicate_markers(self):
        first = install.transform(workbench_fixture(), "base-css", settings=SETTINGS)
        changed = dict(SETTINGS, branchPicker=False)

        second = install.transform(*first, settings=changed)

        self.assertEqual(second[0].count(install.START), 1)
        self.assertEqual(second[0].count(install.END), 1)
        self.assertIn('"branchPicker":false', second[0])
        self.assertNotIn('"branchPicker":true', second[0])

    def test_incomplete_installation_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Incomplete toolkit installation"):
            install.transform(workbench_fixture() + install.START, "base-css", settings=SETTINGS)


class GitConfigTests(unittest.TestCase):
    @patch("install.subprocess.run")
    def test_boolean_git_config_uses_parsed_value(self, run):
        run.return_value = types.SimpleNamespace(returncode=0, stdout="true\n", stderr="")
        self.assertTrue(install.read_git_bool("scm-toolkit.branch-picker", False))

    @patch("install.subprocess.run")
    def test_missing_boolean_git_config_uses_default(self, run):
        run.return_value = types.SimpleNamespace(returncode=1, stdout="", stderr="")
        self.assertTrue(install.read_git_bool("scm-toolkit.branch-picker", True))

    @patch("install.subprocess.run")
    def test_string_git_config_uses_value(self, run):
        run.return_value = types.SimpleNamespace(returncode=0, stdout="upstream\n", stderr="")
        self.assertEqual(install.read_git_string("scm-toolkit.remote", "origin"), "upstream")


if __name__ == "__main__":
    unittest.main()
