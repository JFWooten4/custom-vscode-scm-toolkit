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


class ConfigurationTests(unittest.TestCase):
    @patch.object(ai_commit, "git_config_bool", return_value=False)
    def test_ai_commit_can_be_disabled_globally(self, _config):
        self.assertFalse(ai_commit.feature_enabled())

    @patch.object(ai_commit, "git_config_bool", return_value=False)
    def test_default_branch_description_can_be_disabled(self, _config):
        self.assertFalse(ai_commit.default_branch_description_enabled())

    def test_description_is_limited_to_the_configured_default_branch(self):
        with patch.object(
            ai_commit, "default_branch_description_enabled", return_value=True
        ), patch.object(
            ai_commit, "configured_default_branch", return_value="main"
        ), patch.object(
            ai_commit, "current_branch", return_value="main"
        ):
            self.assertTrue(ai_commit.should_add_default_branch_description())

        with patch.object(
            ai_commit, "default_branch_description_enabled", return_value=True
        ), patch.object(
            ai_commit, "configured_default_branch", return_value="main"
        ), patch.object(
            ai_commit, "current_branch", return_value="feature/test"
        ):
            self.assertFalse(ai_commit.should_add_default_branch_description())

    def test_models_can_be_selected_from_git_config(self):
        values = {
            "scm-toolkit.ai-commit-model": "primary:test",
            "scm-toolkit.ai-commit-low-memory-model": "fallback:test",
        }
        with patch.object(
            ai_commit,
            "git_config_string",
            side_effect=lambda key, default: values.get(key, default),
        ), patch.dict(
            ai_commit.os.environ,
            {"SCM_TOOLKIT_AI_MODEL": "", "SCM_TOOLKIT_AI_LOW_MEMORY_MODEL": ""},
        ):
            self.assertEqual(
                ai_commit.configured_models(),
                ("primary:test", "fallback:test"),
            )

    def test_primary_model_is_used_with_memory_headroom(self):
        with patch.object(
            ai_commit, "configured_models", return_value=("primary:test", "fallback:test")
        ), patch.object(
            ai_commit, "available_memory_bytes", return_value=8 * 1024**3
        ), patch.object(
            ai_commit, "low_memory_threshold_gib", return_value=4
        ):
            self.assertEqual(
                ai_commit.selected_model({"primary:test", "fallback:test"}),
                ("primary:test", False),
            )

    def test_low_memory_model_is_used_below_threshold(self):
        with patch.object(
            ai_commit, "configured_models", return_value=("primary:test", "fallback:test")
        ), patch.object(
            ai_commit, "available_memory_bytes", return_value=2 * 1024**3
        ), patch.object(
            ai_commit, "low_memory_threshold_gib", return_value=4
        ):
            self.assertEqual(
                ai_commit.selected_model({"primary:test", "fallback:test"}),
                ("fallback:test", True),
            )

    def test_low_memory_mode_does_not_escalate_to_primary(self):
        with patch.object(
            ai_commit, "configured_models", return_value=("primary:test", "fallback:test")
        ), patch.object(
            ai_commit, "available_memory_bytes", return_value=2 * 1024**3
        ), patch.object(
            ai_commit, "low_memory_threshold_gib", return_value=4
        ):
            self.assertEqual(
                ai_commit.selected_model({"primary:test"}),
                (None, True),
            )

    @patch.object(
        ai_commit,
        "ollama_json",
        return_value={"models": [{"name": "primary:test"}]},
    )
    def test_local_model_inventory_does_not_require_staged_files(self, _request):
        self.assertEqual(ai_commit.installed_local_model_names(), {"primary:test"})


class TitleTests(unittest.TestCase):
    @patch.object(ai_commit, "recent_subjects", return_value="Fix parser\nAdd tests")
    def test_prompt_is_repository_scoped(self, _subjects):
        prompt = ai_commit.prompt_for_diff("1 file changed", "diff --git a/a b/a")
        self.assertIn("Recent repository subjects:", prompt)
        self.assertIn("Output rules:", prompt)
        self.assertIn("Staged diff:", prompt)

    @patch.object(ai_commit, "recent_subjects", return_value="Update parser")
    def test_default_branch_prompt_requests_one_or_two_sentences(self, _subjects):
        prompt = ai_commit.prompt_for_diff(
            "1 file changed",
            "diff --git a/a b/a",
            include_description=True,
        )
        self.assertIn("one or two complete sentences", prompt)
        self.assertIn("leave one blank line after the subject", prompt)

    def test_description_sanitizer_keeps_at_most_two_sentences(self):
        description = ai_commit.sanitize_description(
            "Body: First substantive sentence. Second useful sentence. Third extra sentence."
        )
        self.assertEqual(
            description,
            "First substantive sentence. Second useful sentence.",
        )

    def test_generated_message_separates_subject_and_description(self):
        title, description = ai_commit.sanitize_generated_message(
            "Add useful behavior\n\nExplain what changed. Explain why it matters.",
            include_description=True,
        )
        self.assertEqual(title, "Add useful behavior")
        self.assertEqual(
            description,
            "Explain what changed. Explain why it matters.",
        )

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


class ArtifactContextTests(unittest.TestCase):
    def test_large_single_file_diff_keeps_beginning_and_tail(self):
        diff = (
            "diff --git a/docs/report.md b/docs/report.md\n"
            "HEAD_SIGNAL\n"
            + ("x" * 900)
            + "\nTAIL_SIGNAL"
        )
        with patch.object(ai_commit, "MAX_DIFF_CHARS", 400):
            sampled = ai_commit.sample_diff_for_prompt(diff)

        self.assertIn("HEAD_SIGNAL", sampled)
        self.assertIn("TAIL_SIGNAL", sampled)
        self.assertLessEqual(len(sampled), 400)
        self.assertIn("diff sampled", sampled)

    def test_large_multifile_diff_samples_across_files(self):
        sections = []
        for name in ("first.md", "middle.md", "last.md"):
            sections.append(
                f"diff --git a/{name} b/{name}\n{name}\n" + ("z" * 700)
            )

        with patch.object(ai_commit, "MAX_DIFF_CHARS", 900), patch.object(
            ai_commit, "MAX_DIFF_SECTIONS", 3
        ):
            sampled = ai_commit.sample_diff_for_prompt("\n".join(sections))

        for name in ("first.md", "middle.md", "last.md"):
            self.assertIn(name, sampled)
        self.assertLessEqual(len(sampled), 900)

    def test_file_context_marks_binary_images_and_documents(self):
        def fake_git_output(*args):
            if "--name-status" in args:
                return "A\tassets/logo.png\nM\tdocs/report.pdf\nM\tREADME.md\n"
            if "--numstat" in args:
                return (
                    "-\t-\tassets/logo.png\n"
                    "-\t-\tdocs/report.pdf\n"
                    "4\t1\tREADME.md\n"
                )
            self.fail(f"unexpected git call: {args}")

        with patch.object(ai_commit, "git_output", side_effect=fake_git_output):
            context = ai_commit.staged_file_context(
                ["assets/logo.png", "docs/report.pdf", "README.md"]
            )

        self.assertIn("image: assets/logo.png (binary)", context)
        self.assertIn("document: docs/report.pdf (binary)", context)
        self.assertIn("README.md", context)

    @patch.object(ai_commit, "recent_subjects", return_value="Update parser")
    def test_prompt_includes_context_without_claiming_opaque_contents(self, _subjects):
        prompt = ai_commit.prompt_for_diff(
            "2 files changed",
            "diff --git a/README.md b/README.md\n+text",
            "- image: assets/logo.png (binary)",
        )
        self.assertIn("Staged file context:", prompt)
        self.assertIn("do not invent contents", prompt)


if __name__ == "__main__":
    unittest.main()
