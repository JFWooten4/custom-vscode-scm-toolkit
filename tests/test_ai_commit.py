import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "scm_toolkit_ai_commit", Path(__file__).parents[1] / "ai_commit.py"
)
ai_commit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ai_commit)


class RoutingTests(unittest.TestCase):
    def test_finds_commit_after_global_option(self):
        self.assertEqual(ai_commit.commit_index(["-C", "/tmp/repo", "commit"]), 2)

    def test_preserves_explicit_message(self):
        self.assertTrue(ai_commit.has_explicit_message_or_special_mode(["-m", "Manual"]))
        self.assertTrue(
            ai_commit.has_explicit_message_or_special_mode(["--message=Manual"])
        )

    def test_rejects_path_and_all_modes(self):
        self.assertFalse(ai_commit.uses_staged_index(["README.md"]))
        self.assertFalse(ai_commit.uses_staged_index(["--all"]))

    def test_accepts_plain_staged_commit(self):
        self.assertTrue(ai_commit.uses_staged_index([]))
        self.assertTrue(ai_commit.uses_staged_index(["--quiet"]))


class TitleTests(unittest.TestCase):
    @patch.object(ai_commit, "recent_subjects", return_value="Fix parser\nAdd tests")
    def test_prompt_is_portable_and_repository_scoped(self, _subjects):
        prompt = ai_commit.prompt_for_diff("1 file changed", "diff --git a/a b/a")
        self.assertIn("Recent repository subjects:", prompt)
        self.assertNotIn("Codex", prompt)
        self.assertNotIn("instruction file", prompt.lower())
        self.assertNotIn("style file", prompt.lower())

    def test_sanitize_title_limits_output(self):
        title = ai_commit.sanitize_title(
            "\""
            "This is a deliberately long generated commit title that should be shortened "
            "without leaving a trailing punctuation mark.\""
        )
        self.assertLessEqual(len(title), 72)
        self.assertFalse(title.endswith("."))

    def test_fallback_uses_staged_paths_only(self):
        self.assertEqual(ai_commit.fallback_title(["src/widget.js"]), "Update widget.js")
        self.assertEqual(
            ai_commit.fallback_title(["src/a.js", "src/b.js"]),
            "Update 2 staged files",
        )

    @patch.object(ai_commit, "installed_local_model_names", return_value=set())
    def test_missing_model_uses_local_fallback(self, _models):
        self.assertEqual(
            ai_commit.generate_title("1 file", "diff", ["README.md"]),
            "Update README.md",
        )


if __name__ == "__main__":
    unittest.main()
