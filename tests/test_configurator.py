import json
import threading
import urllib.parse
import urllib.request
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import configurator
import install


def form_values():
    values = {}
    for setting in configurator.SETTINGS:
        current = install.DEFAULT_SETTINGS[setting.name]
        if setting.kind == "bool":
            if current:
                values[setting.name] = ["true"]
        else:
            values[setting.name] = [str(current)]
    return values


class SubmissionTests(unittest.TestCase):
    def test_parses_checked_and_unchecked_switches(self):
        values = form_values()
        values.pop("branchPicker")

        parsed = configurator.parse_submission(values)

        self.assertFalse(parsed["branchPicker"])
        self.assertTrue(parsed["commitAndPush"])
        self.assertEqual(parsed["aiCommitModel"], "qwen2.5-coder:7b")

    def test_rejects_invalid_memory_threshold(self):
        values = form_values()
        values["aiLowMemoryGiB"] = ["0"]

        with self.assertRaisesRegex(ValueError, "greater than zero"):
            configurator.parse_submission(values)

    def test_form_escapes_values_and_lists_local_models(self):
        current = dict(install.DEFAULT_SETTINGS, defaultBranch='<script>alert("x")</script>')

        page = configurator.render_form(
            current,
            ["local:model"],
            "Detected one model.",
            "test-token",
            "Save and install",
        )

        self.assertNotIn('<script>alert("x")</script>', page)
        self.assertIn("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;", page)
        self.assertIn('<option value="local:model">', page)
        self.assertIn("/save?token=test-token", page)


class GitConfigTests(unittest.TestCase):
    @patch("configurator.shutil.which", return_value="/usr/bin/git")
    @patch("configurator.subprocess.run")
    def test_saves_every_supported_setting(self, run, _which):
        run.side_effect = lambda args, **_kwargs: SimpleNamespace(
            returncode=1 if "--get" in args else 0,
            stdout="",
            stderr="",
        )

        configurator.save_settings(configurator.parse_submission(form_values()))

        writes = [call.args[0] for call in run.call_args_list if "--replace-all" in call.args[0]]
        self.assertEqual(len(writes), len(configurator.SETTINGS))
        self.assertIn(
            [
                "/usr/bin/git",
                "config",
                "--global",
                "--replace-all",
                "scm-toolkit.ai-commit-model",
                "qwen2.5-coder:7b",
            ],
            writes,
        )


class OllamaTests(unittest.TestCase):
    @patch("configurator.urllib.request.build_opener")
    def test_reads_models_from_local_ollama(self, build_opener):
        response = unittest.mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(
            {"models": [{"name": "qwen:test"}, {"model": "other:test"}]}
        ).encode()
        build_opener.return_value.open.return_value = response

        models, status = configurator.fetch_ollama_models()

        self.assertEqual(models, ["other:test", "qwen:test"])
        self.assertIn("2 local Ollama models", status)
        build_opener.return_value.open.assert_called_once_with(
            "http://127.0.0.1:11434/api/tags", timeout=2
        )


class ServerTests(unittest.TestCase):
    @patch("configurator.fetch_ollama_models", return_value=([], "Ollama offline"))
    def test_local_server_serves_form_and_can_cancel(self, _models):
        opened = threading.Event()
        captured = {}
        result = {}

        def open_browser(url):
            captured["url"] = url
            opened.set()
            return True

        def run_server():
            result["saved"] = configurator.run_configurator(install.DEFAULT_SETTINGS)

        with patch("configurator.webbrowser.open", side_effect=open_browser):
            thread = threading.Thread(target=run_server)
            thread.start()
            self.assertTrue(opened.wait(5))
            with urllib.request.urlopen(captured["url"], timeout=5) as response:
                page = response.read().decode()
            self.assertIn("SCM Toolkit Setup", page)

            parsed_url = urllib.parse.urlsplit(captured["url"])
            cancel_url = urllib.parse.urlunsplit(
                (parsed_url.scheme, parsed_url.netloc, "/save", parsed_url.query, "")
            )
            request = urllib.request.Request(
                cancel_url,
                data=b"action=cancel",
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=5) as response:
                self.assertIn("Configuration cancelled", response.read().decode())
            thread.join(5)

        self.assertFalse(thread.is_alive())
        self.assertFalse(result["saved"])


if __name__ == "__main__":
    unittest.main()
