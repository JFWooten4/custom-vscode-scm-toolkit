from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

import install


SETTINGS = {
    "branchPicker": True,
    "shortPlaceholder": True,
    "filledButtons": False,
    "commitAndPush": True,
    "branchCleanup": True,
    "autocompleteToggle": True,
    "codexCoauthor": True,
    "hideOutgoingSyncCount": True,
    "blankStateRefresh": True,
    "aiCommit": True,
    "aiDefaultBranchDescription": True,
    "aiCommitModel": "qwen2.5-coder:7b",
    "aiCommitLowMemoryModel": "qwen2.5-coder:3b",
    "aiLowMemoryGiB": "4",
    "aiModelPicker": True,
    "mcpPullRequest": True,
    "mcpPrServer": "codex-drafter",
    "mcpPrTool": "github_create_pull_request",
    "codexUsageResetCountdown": False,
    "defaultBranch": "main",
    "remote": "origin",
}


def workbench_fixture():
    return "".join(
        [
            'cmd=svc("commandService")',
            'notify=svc("notificationService")',
            'config=svc("configurationService")',
            'mcp=svc("IMcpService")',
            'function watch(s,o=source.ofCaller()){return new first(new second(void 0,void 0,s),s,void 0,o)}',
            'this.disposables.add(this.toolbar)}static{this.ValidationTimeouts=',
            'this.inputEditor.setModel(void 0),this.model=void 0;return}'
            'let e=o.repository.provider.inputBoxTextModel;',
            'this.toolbar.setInput(o),this.model={input:o,textModel:e}}get selections()',
            't=new size(this.element.clientWidth-e,o);if(t.width<0)',
        ]
    )


class TransformTests(unittest.TestCase):
    def test_controls_use_the_vscode_input_background(self):
        css = (install.HERE / "picker.css").read_text()

        self.assertEqual(css.count("background: var(--vscode-input-background);"), 5)
        self.assertEqual(css.count("background: transparent;"), 1)

    def test_branch_selector_uses_the_vscode_button_colors(self):
        css = (install.HERE / "picker.css").read_text()

        self.assertIn("background: var(--vscode-button-background);", css)
        self.assertIn("color: var(--vscode-button-foreground);", css)
        self.assertIn("background: var(--vscode-button-hoverBackground);", css)

    def test_unfilled_buttons_match_their_background_with_a_border(self):
        css = (install.HERE / "outlined_buttons.css").read_text()

        self.assertIn(
            ".scm-view .button-container > .monaco-button-dropdown", css
        )
        self.assertIn(
            "border: 1px solid var(--vscode-button-border, var(--vscode-widget-border));",
            css,
        )
        self.assertEqual(css.count("--vscode-button-background: transparent;"), 2)
        self.assertIn("background: transparent !important;", css)

    def test_filled_button_setting_controls_outlined_stylesheet(self):
        _, outlined_css = install.transform(
            workbench_fixture(), "base-css", settings=SETTINGS
        )
        _, filled_css = install.transform(
            workbench_fixture(),
            "base-css",
            settings=dict(SETTINGS, filledButtons=True),
        )

        selector = ".scm-view .button-container > .monaco-button-dropdown"
        self.assertIn(selector, outlined_css)
        self.assertNotIn(selector, filled_css)

    def test_push_control_is_centered_without_a_divider(self):
        css = (install.HERE / "picker.css").read_text()
        push_css = css.split(
            ".scm-view .scm-editor > .scm-toolkit-push {", 1
        )[1].split(
            ".scm-view .scm-editor > .scm-toolkit-push[hidden]", 1
        )[0]

        self.assertNotIn("border-left", push_css)
        self.assertIn("height: 22px;", push_css)
        self.assertIn("margin: 2px 2px 2px 0;", push_css)
        self.assertIn("border-radius: var(--vscode-cornerRadius-small, 4px);", push_css)

    def test_right_side_controls_have_no_vertical_dividers(self):
        css = (install.HERE / "picker.css").read_text()

        for selector in ("scm-toolkit-delete-branch", "scm-toolkit-autocomplete"):
            control_css = css.split(
                f".scm-view .scm-editor > .{selector} {{", 1
            )[1].split(
                f".scm-view .scm-editor > .{selector}[hidden]", 1
            )[0]
            self.assertNotIn("border-left", control_css)

    def test_install_injects_valid_settings_line(self):
        js, css = install.transform(workbench_fixture(), "base-css", settings=SETTINGS)

        self.assertIn(
            'const scmToolkitSettings = '
            '{"branchPicker":true,"shortPlaceholder":true,"filledButtons":false,'
            '"commitAndPush":true,'
            '"branchCleanup":true,"autocompleteToggle":true,"codexCoauthor":true,'
            '"hideOutgoingSyncCount":true,"blankStateRefresh":true,'
            '"aiCommit":true,'
            '"aiDefaultBranchDescription":true,'
            '"aiCommitModel":"qwen2.5-coder:7b",'
            '"aiCommitLowMemoryModel":"qwen2.5-coder:3b",'
            '"aiLowMemoryGiB":"4","aiModelPicker":true,'
            '"mcpPullRequest":true,'
            '"mcpPrServer":"codex-drafter","mcpPrTool":"github_create_pull_request",'
            '"codexUsageResetCountdown":false,'
            '"defaultBranch":"main","remote":"origin"};\n',
            js,
        )
        self.assertIn("editor.inlineSuggest.enabled", js)
        self.assertIn("commands.executeCommand('git.refresh', repositoryArgument)", js)
        self.assertIn("scm-toolkit-autocomplete", css)
        self.assertEqual(js.count("className = 'scm-toolkit-tooltip'"), 3)
        self.assertIn(".scm-toolkit-autocomplete:hover > .scm-toolkit-tooltip", css)
        self.assertIn("Co-authored-by: Codex Web <noreply@openai.com>", js)
        self.assertIn("currentCommitCommand = provider.acceptInputCommand", js)
        self.assertIn("currentCommitCommand.id,", js)
        self.assertIn("...(currentCommitCommand.arguments ?? [])", js)
        self.assertNotIn("commands.executeCommand('git.commit', currentRepositoryArgument)", js)
        self.assertIn("mcpService.activateCollections()", js)
        self.assertIn("mcpService.servers.get()", js)
        self.assertIn("server.start({ promptType: 'all-untrusted' })", js)
        self.assertIn("const result = await tool.call({", js)
        self.assertIn("github_create_pull_request", js)
        self.assertIn("scm-toolkit-pull-request", css)
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


class AiWrapperTests(unittest.TestCase):
    def test_sync_ai_wrapper_installs_executable_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "bin" / "scm-toolkit-git"
            self.assertTrue(install.sync_ai_wrapper(check=True, destination=destination))
            self.assertFalse(destination.exists())

            self.assertTrue(install.sync_ai_wrapper(destination=destination))
            self.assertEqual(destination.read_bytes(), (install.HERE / "ai_commit.py").read_bytes())
            self.assertTrue(destination.stat().st_mode & 0o111)
            self.assertFalse(install.sync_ai_wrapper(check=True, destination=destination))

    def test_sync_ai_wrapper_uninstall_removes_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "scm-toolkit-git"
            install.sync_ai_wrapper(destination=destination)
            self.assertTrue(install.sync_ai_wrapper(remove=True, check=True, destination=destination))
            self.assertTrue(destination.exists())
            install.sync_ai_wrapper(remove=True, destination=destination)
            self.assertFalse(destination.exists())


    def test_sync_model_picker_installs_executable_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "bin" / "scm-toolkit-models"
            self.assertTrue(
                install.sync_model_picker(
                    enabled=True, check=True, destination=destination
                )
            )
            self.assertFalse(destination.exists())

            self.assertTrue(
                install.sync_model_picker(enabled=True, destination=destination)
            )
            self.assertEqual(
                destination.read_bytes(),
                (install.HERE / "model_picker.py").read_bytes(),
            )
            self.assertTrue(destination.stat().st_mode & 0o111)

    def test_disabling_model_picker_removes_installed_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "scm-toolkit-models"
            install.sync_model_picker(enabled=True, destination=destination)
            self.assertTrue(destination.exists())

            self.assertTrue(
                install.sync_model_picker(
                    enabled=False, check=True, destination=destination
                )
            )
            self.assertTrue(destination.exists())
            install.sync_model_picker(enabled=False, destination=destination)
            self.assertFalse(destination.exists())


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


class CodexCountdownTests(unittest.TestCase):
    def fixture(self):
        return (
            "function banner(){let V={},ne=123,We=false,Ge="
            "ne==null?null:oE(V,ne,We),unused=true;"
            "return (0,L4.jsx)(Y,{id:`codex.upsellBanner.general.title`,"
            "defaultMessage:`You’re out of Codex messages`,"
            "values:{resetDate:Ge}})}"
        )

    def test_countdown_is_off_by_default(self):
        self.assertFalse(install.DEFAULT_SETTINGS["codexUsageResetCountdown"])

    def test_codex_countdown_install_and_remove_round_trip(self):
        original = self.fixture()
        patched = install.transform_codex(original, enabled=True)

        self.assertIn("scm-toolkit-usage-reset-countdown", patched)
        self.assertIn('"reset-at":ne', patched)
        self.assertEqual(patched.count(install.CODEX_START), 1)
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def test_codex_countdown_disabled_removes_existing_patch(self):
        original = self.fixture()
        patched = install.transform_codex(original, enabled=True)

        self.assertEqual(install.transform_codex(patched, enabled=False), original)


if __name__ == "__main__":
    unittest.main()
