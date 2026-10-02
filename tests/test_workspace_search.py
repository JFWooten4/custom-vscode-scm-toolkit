from pathlib import Path
import json
import tempfile
import unittest

import toolkit_settings
import workspace_search


DEFAULTS = dict(toolkit_settings.DEFAULT_SETTINGS)


class WorkspaceSearchInstallerTests(unittest.TestCase):
    def test_extension_registers_settings_launcher(self):
        package = json.loads((workspace_search.SOURCE / "package.json").read_text())
        command_ids = {command["command"] for command in package["contributes"]["commands"]}

        self.assertIn("onCommand:scmToolkit.openSettings", package["activationEvents"])
        self.assertIn("scmToolkit.openSettings", command_ids)
        self.assertIn("scmToolkit.chatgpt.searchRepositories", command_ids)
        self.assertIn(
            "onCommand:scmToolkit.chatgpt.searchRepositories",
            package["activationEvents"],
        )
        self.assertIn(
            "vscode.commands.registerCommand('scmToolkit.openSettings'",
            (workspace_search.SOURCE / "extension.js").read_text(),
        )

    def test_default_manifest_stays_in_source_control(self):
        package = workspace_search.render_package(DEFAULTS)

        self.assertFalse(DEFAULTS["workspaceSearchActivityBar"])
        self.assertEqual(list(package["contributes"]["views"]), ["scm"])
        self.assertNotIn("viewsContainers", package["contributes"])
        self.assertEqual(package["contributes"]["views"]["scm"][0]["name"], "EFS")
        properties = package["contributes"]["configuration"]["properties"]
        self.assertFalse(DEFAULTS["workspaceSearchAskOllama"])
        self.assertFalse(properties["scmToolkit.workspaceSearch.askOllama"]["default"])
        self.assertEqual(properties["scmToolkit.workspaceSearch.chatModel"]["default"], "")

    def test_ask_ollama_manifest_requires_opt_in_model(self):
        settings = dict(
            DEFAULTS,
            workspaceSearchAskOllama=True,
            workspaceSearchChatModel="qwen3:8b",
        )
        package = workspace_search.render_package(settings)
        properties = package["contributes"]["configuration"]["properties"]

        self.assertTrue(properties["scmToolkit.workspaceSearch.askOllama"]["default"])
        self.assertEqual(properties["scmToolkit.workspaceSearch.chatModel"]["default"], "qwen3:8b")
        view = (workspace_search.SOURCE / "view.js").read_text()
        self.assertIn("if (this.getSettings().askOllama) await this.askOllama()", view)
        self.assertIn("const askButton = askEnabled", view)
        self.assertNotIn("resolveChatModel", view)

    def test_standalone_manifest_uses_activity_bar_and_efs_label(self):
        settings = dict(DEFAULTS, workspaceSearchActivityBar=True)
        package = workspace_search.render_package(settings)
        container = package["contributes"]["viewsContainers"]["activitybar"][0]

        self.assertEqual(DEFAULTS["workspaceSearchLabel"], "EFS")
        self.assertEqual(container["id"], workspace_search.STANDALONE_CONTAINER_ID)
        self.assertEqual(container["title"], "EFS")
        self.assertEqual(container["icon"], "$(search)")
        self.assertEqual(
            list(package["contributes"]["views"]),
            [workspace_search.STANDALONE_CONTAINER_ID],
        )

    def test_standalone_manifest_uses_custom_label(self):
        settings = dict(
            DEFAULTS,
            workspaceSearchActivityBar=True,
            workspaceSearchLabel="Research",
        )
        package = workspace_search.render_package(settings)

        self.assertEqual(
            package["contributes"]["viewsContainers"]["activitybar"][0]["title"],
            "Research",
        )
        view = package["contributes"]["views"][workspace_search.STANDALONE_CONTAINER_ID][0]
        self.assertEqual(view["name"], "Research")
        self.assertEqual(view["contextualTitle"], "Research")

    def test_installs_exact_extension_tree(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            destination = workspace_search.extension_destination(root)

            self.assertTrue(
                workspace_search.sync_extension(
                    check=True,
                    extensions_dir=root,
                    settings=DEFAULTS,
                )
            )
            self.assertFalse(destination.exists())
            self.assertTrue(
                workspace_search.sync_extension(
                    extensions_dir=root,
                    settings=DEFAULTS,
                )
            )
            self.assertTrue(
                workspace_search.destination_matches(
                    destination,
                    settings=DEFAULTS,
                )
            )
            self.assertTrue((destination / "configurator.py").is_file())
            self.assertTrue((destination / "toolkit_settings.py").is_file())
            self.assertTrue((destination / "branch_names.py").is_file())
            self.assertTrue((destination / "branch_name_packs.json").is_file())
            self.assertTrue((destination / "chatgpt_integration.py").is_file())
            self.assertFalse(
                workspace_search.sync_extension(
                    check=True,
                    extensions_dir=root,
                    settings=DEFAULTS,
                )
            )

    def test_setting_change_marks_extension_for_update(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            destination = workspace_search.extension_destination(root)
            workspace_search.sync_extension(
                extensions_dir=root,
                settings=DEFAULTS,
            )

            standalone = dict(DEFAULTS, workspaceSearchActivityBar=True)
            self.assertFalse(
                workspace_search.destination_matches(
                    destination,
                    settings=standalone,
                )
            )
            self.assertTrue(
                workspace_search.sync_extension(
                    check=True,
                    extensions_dir=root,
                    settings=standalone,
                )
            )

    def test_removes_installed_extension(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace_search.sync_extension(
                extensions_dir=root,
                settings=DEFAULTS,
            )
            self.assertTrue(
                workspace_search.sync_extension(
                    remove=True,
                    check=True,
                    extensions_dir=root,
                    settings=DEFAULTS,
                )
            )
            self.assertTrue(
                workspace_search.sync_extension(
                    remove=True,
                    extensions_dir=root,
                    settings=DEFAULTS,
                )
            )
            self.assertEqual(workspace_search.installed_versions(root), [])

    def test_upgrade_removes_stale_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stale = root / "jfwooten4.scm-toolkit-workspace-search-0.0.1"
            stale.mkdir(parents=True)
            (stale / "old.txt").write_text("old")

            self.assertTrue(
                workspace_search.sync_extension(
                    extensions_dir=root,
                    settings=DEFAULTS,
                )
            )
            self.assertFalse(stale.exists())
            self.assertTrue(
                workspace_search.destination_matches(
                    workspace_search.extension_destination(root),
                    settings=DEFAULTS,
                )
            )


if __name__ == "__main__":
    unittest.main()
