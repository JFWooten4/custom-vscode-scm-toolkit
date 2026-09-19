#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

REAL_GIT = os.environ.get("SCM_TOOLKIT_REAL_GIT", "/usr/bin/git")
GIT_GLOBAL_ARGS: list[str] = []
OLLAMA_BASE = "http://127.0.0.1:11434"
OLLAMA_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
DEFAULT_MODEL = "qwen2.5-coder:7b"
NUM_CTX = int(os.environ.get("SCM_TOOLKIT_AI_NUM_CTX", "4096"))
MAX_DIFF_CHARS = int(os.environ.get("SCM_TOOLKIT_AI_MAX_DIFF_CHARS", "14000"))

EXPLICIT_MESSAGE_FLAGS = {
    "-e",
    "--edit",
    "--amend",
    "-C",
    "-c",
    "--reuse-message",
    "--reedit-message",
    "--fixup",
    "--squash",
}
EXPLICIT_MESSAGE_PREFIXES = (
    "-m",
    "-F",
    "--message=",
    "--file=",
    "--reuse-message=",
    "--reedit-message=",
    "--fixup=",
    "--squash=",
)


def git_output(*args: str) -> str:
    result = subprocess.run(
        [REAL_GIT, *GIT_GLOBAL_ARGS, *args],
        check=False,
        capture_output=True,
        text=True,
    )
    return result.stdout


def git_config_bool(key: str, default: bool) -> bool:
    result = subprocess.run(
        [REAL_GIT, "config", "--global", "--type=bool", "--get", key],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return default
    return result.stdout.strip() == "true"


def git_config_string(key: str, default: str) -> str:
    result = subprocess.run(
        [REAL_GIT, "config", "--global", "--get", key],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return default
    value = result.stdout.strip()
    return value or default


def feature_enabled() -> bool:
    return git_config_bool("scm-toolkit.ai-commit", True)


def configured_model() -> str:
    return os.environ.get("SCM_TOOLKIT_AI_MODEL") or git_config_string(
        "scm-toolkit.ai-commit-model", DEFAULT_MODEL
    )


def commit_index(argv: list[str]) -> int | None:
    """Find a commit subcommand without treating global option values as commands."""
    value_options = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"}
    flag_options = {
        "--no-pager",
        "--paginate",
        "-P",
        "-p",
        "--no-optional-locks",
        "--literal-pathspecs",
        "--glob-pathspecs",
        "--noglob-pathspecs",
        "--icase-pathspecs",
        "--no-replace-objects",
        "--bare",
    }

    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg in value_options:
            index += 2
        elif arg in flag_options:
            index += 1
        elif any(
            arg.startswith(option + "=")
            for option in value_options
            if option.startswith("--")
        ):
            index += 1
        elif arg.startswith(("-C", "-c")) and len(arg) > 2:
            index += 1
        else:
            return index if arg == "commit" else None
    return None


def has_explicit_message_or_special_mode(args: list[str]) -> bool:
    for arg in args:
        if arg in EXPLICIT_MESSAGE_FLAGS:
            return True
        if any(
            arg.startswith(prefix) and arg != prefix
            for prefix in EXPLICIT_MESSAGE_PREFIXES
        ):
            return True
        if arg in {"-m", "-F", "--message", "--file"}:
            return True
    return False


def uses_staged_index(args: list[str]) -> bool:
    """Only summarize commits known to use the existing staged index."""
    flags = {
        "--quiet",
        "-q",
        "--verbose",
        "-v",
        "--no-verify",
        "-n",
        "--signoff",
        "-s",
        "--no-signoff",
        "--gpg-sign",
        "-S",
        "--no-gpg-sign",
        "--allow-empty",
        "--allow-empty-message",
        "--no-post-rewrite",
        "--no-status",
        "--status",
    }
    return all(arg in flags or arg.startswith("--gpg-sign=") for arg in args)


def staged_diff() -> tuple[str, str, list[str]]:
    stat = git_output("diff", "--cached", "--stat", "--no-ext-diff").strip()
    diff = git_output(
        "diff",
        "--cached",
        "--no-ext-diff",
        "--unified=2",
        "--no-color",
    ).strip()
    files = [
        line.strip()
        for line in git_output("diff", "--cached", "--name-only").splitlines()
        if line.strip()
    ]
    return stat, diff, files


def recent_subjects() -> str:
    return git_output("log", "-8", "--pretty=%s").strip()


def ollama_json(path: str, payload: dict | None = None, timeout: int = 120) -> dict:
    url = f"{OLLAMA_BASE}{path}"
    data = None
    headers = {}
    method = "GET"
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
        method = "POST"

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    with OLLAMA_OPENER.open(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def installed_local_model_names() -> set[str]:
    try:
        response = ollama_json("/api/tags", timeout=3)
    except Exception:
        return set()

    names = set()
    for model in response.get("models", []):
        for key in ("name", "model"):
            value = model.get(key)
            if isinstance(value, str) and value:
                names.add(value)
    return names


def prompt_for_diff(stat: str, diff: str) -> str:
    clipped = diff
    if len(clipped) > MAX_DIFF_CHARS:
        clipped = clipped[:MAX_DIFF_CHARS] + "\n[diff truncated]"

    history = recent_subjects()
    return f"""Write exactly one Git commit subject for the staged changes below.

Output rules:
- output only the subject line
- maximum 72 characters
- use concise imperative wording
- describe the intent rather than listing files
- no markdown, quotes, explanation, or trailing period

Recent repository subjects:
{history or "[none]"}

Staged diff stat:
{stat}

Staged diff:
{clipped}
"""


def sanitize_title(text: str) -> str:
    line = next((line.strip() for line in text.splitlines() if line.strip()), "")
    line = re.sub(r"^(?:[-*]\s+|`+|[\"'])", "", line)
    line = re.sub(r"(?:`+|[\"'])$", "", line).strip()
    line = line.rstrip(".")
    if len(line) > 72:
        shortened = line[:72]
        if " " in shortened:
            shortened = shortened.rsplit(" ", 1)[0]
        line = shortened.rstrip(" .,:;-")
    return line


def fallback_title(files: list[str]) -> str:
    if len(files) == 1:
        return sanitize_title(f"Update {os.path.basename(files[0])}")
    if files:
        return f"Update {len(files)} staged files"
    return "Update staged changes"


def generate_title(stat: str, diff: str, files: list[str]) -> str:
    model = configured_model()
    if model not in installed_local_model_names():
        print(
            f"scm-toolkit: {model} is not installed locally; using fallback title",
            file=sys.stderr,
        )
        return fallback_title(files)

    try:
        response = ollama_json(
            "/api/generate",
            {
                "model": model,
                "prompt": prompt_for_diff(stat, diff),
                "stream": False,
                "options": {
                    "num_ctx": NUM_CTX,
                    "temperature": 0.2,
                    "num_predict": 40,
                },
            },
        )
        title = sanitize_title(str(response.get("response", "")))
        if title:
            return title
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        print(
            f"scm-toolkit: local model unavailable ({exc}); using fallback title",
            file=sys.stderr,
        )
    except Exception as exc:
        print(
            f"scm-toolkit: title generation failed ({exc}); using fallback title",
            file=sys.stderr,
        )

    return fallback_title(files)

def main() -> None:
    global GIT_GLOBAL_ARGS

    argv = sys.argv[1:]
    if not feature_enabled():
        os.execv(REAL_GIT, [REAL_GIT, *argv])
    index = commit_index(argv)
    commit_args = argv[index + 1 :] if index is not None else []
    if (
        index is None
        or has_explicit_message_or_special_mode(commit_args)
        or not uses_staged_index(commit_args)
    ):
        os.execv(REAL_GIT, [REAL_GIT, *argv])

    GIT_GLOBAL_ARGS = argv[:index]
    stat, diff, files = staged_diff()
    if not stat and not diff:
        os.execv(REAL_GIT, [REAL_GIT, *argv])

    title = generate_title(stat, diff, files)
    os.execv(REAL_GIT, [REAL_GIT, *argv, "-m", title])


if __name__ == "__main__":
    main()
