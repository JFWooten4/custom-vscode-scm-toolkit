from pathlib import Path
import json
import tempfile
import unittest

import workspace_search


class WorkspaceSearchInstallerTests(unittest.TestCase):
    def test_extension_registers_settings_launcher(self):
        package = json.loads((workspace_search.SOURCE / "package.json").read_text())
        command_ids = {command["command"] for command in package["contributes"]["commands"]}

        self.assertIn("onCommand:scmToolkit.openSettings", package["activationEvents"])
        self.assertIn("scmToolkit.openSettings", command_ids)
        self.assertIn(
            "vscode.commands.registerCommand('scmToolkit.openSettings'",
            (workspace_search.SOURCE / "extension.js").read_text(),
        )

    def test_installs_exact_extension_tree(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            destination = workspace_search.extension_destination(root)

            self.assertTrue(workspace_search.sync_extension(check=True, extensions_dir=root))
            self.assertFalse(destination.exists())
            self.assertTrue(workspace_search.sync_extension(extensions_dir=root))
            self.assertTrue(workspace_search.destination_matches(destination))
            self.assertTrue((destination / "configurator.py").is_file())
            self.assertTrue((destination / "toolkit_settings.py").is_file())
            self.assertFalse(workspace_search.sync_extension(check=True, extensions_dir=root))

    def test_removes_installed_extension(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace_search.sync_extension(extensions_dir=root)
            self.assertTrue(workspace_search.sync_extension(remove=True, check=True, extensions_dir=root))
            self.assertTrue(workspace_search.sync_extension(remove=True, extensions_dir=root))
            self.assertEqual(workspace_search.installed_versions(root), [])

    def test_upgrade_removes_stale_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stale = root / "jfwooten4.scm-toolkit-workspace-search-0.0.1"
            stale.mkdir(parents=True)
            (stale / "old.txt").write_text("old")

            self.assertTrue(workspace_search.sync_extension(extensions_dir=root))
            self.assertFalse(stale.exists())
            self.assertTrue(workspace_search.destination_matches(workspace_search.extension_destination(root)))


if __name__ == "__main__":
    unittest.main()
