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
DEFAULT_LOW_MEMORY_MODEL = "qwen2.5-coder:3b"
DEFAULT_LOW_MEMORY_GIB = 4.0
NUM_CTX = int(os.environ.get("SCM_TOOLKIT_AI_NUM_CTX", "4096"))
MAX_DIFF_CHARS = int(os.environ.get("SCM_TOOLKIT_AI_MAX_DIFF_CHARS", "14000"))
MAX_FILE_CONTEXT_CHARS = int(
    os.environ.get("SCM_TOOLKIT_AI_MAX_FILE_CONTEXT_CHARS", "5000")
)
MAX_DIFF_SECTIONS = int(os.environ.get("SCM_TOOLKIT_AI_MAX_DIFF_SECTIONS", "20"))

IMAGE_EXTENSIONS = {
    ".avif",
    ".bmp",
    ".gif",
    ".heic",
    ".jpeg",
    ".jpg",
    ".png",
    ".svg",
    ".tif",
    ".tiff",
    ".webp",
}
DOCUMENT_EXTENSIONS = {
    ".doc",
    ".docx",
    ".epub",
    ".odt",
    ".pages",
    ".pdf",
    ".rtf",
}

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


def git_config_float(key: str, default: float) -> float:
    value = git_config_string(key, "")
    if not value:
        return default
    try:
        return float(value)
    except ValueError:
        return default


def feature_enabled() -> bool:
    return git_config_bool("scm-toolkit.ai-commit", True)


def configured_models() -> tuple[str, str]:
    primary = os.environ.get("SCM_TOOLKIT_AI_MODEL") or git_config_string(
        "scm-toolkit.ai-commit-model", DEFAULT_MODEL
    )
    low_memory = os.environ.get("SCM_TOOLKIT_AI_LOW_MEMORY_MODEL") or git_config_string(
        "scm-toolkit.ai-commit-low-memory-model", DEFAULT_LOW_MEMORY_MODEL
    )
    return primary, low_memory


def low_memory_threshold_gib() -> float:
    value = os.environ.get("SCM_TOOLKIT_AI_LOW_MEMORY_GIB")
    if value:
        try:
            return float(value)
        except ValueError:
            pass
    return git_config_float("scm-toolkit.ai-low-memory-gib", DEFAULT_LOW_MEMORY_GIB)


def available_memory_bytes() -> int | None:
    try:
        result = subprocess.run(
            ["/usr/bin/memory_pressure", "-Q"],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return None

    text = result.stdout + "\n" + result.stderr
    total_match = re.search(r"The system has\s+(\d+)", text)
    free_match = re.search(
        r"System-wide memory free percentage:\s*([0-9]+(?:\.[0-9]+)?)%",
        text,
    )
    if not total_match or not free_match:
        return None

    total_bytes = int(total_match.group(1))
    free_percent = float(free_match.group(1))
    return int(total_bytes * free_percent / 100.0)


def selected_model(installed: set[str]) -> tuple[str | None, bool]:
    primary, low_memory = configured_models()
    available = available_memory_bytes()
    threshold = int(low_memory_threshold_gib() * 1024**3)
    low_memory_mode = available is not None and available < threshold

    if low_memory_mode:
        return (low_memory if low_memory in installed else None), True

    if primary in installed:
        return primary, False
    if low_memory in installed:
        return low_memory, False
    return None, False


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


def path_kind(path: str) -> str | None:
    extension = os.path.splitext(path.lower())[1]
    if extension in IMAGE_EXTENSIONS:
        return "image"
    if extension in DOCUMENT_EXTENSIONS:
        return "document"
    return None


def staged_file_context(files: list[str]) -> str:
    """Describe staged paths that are not represented well by patch text."""
    status = git_output(
        "diff", "--cached", "--name-status", "--find-renames", "--no-ext-diff"
    ).strip()
    numstat = git_output(
        "diff", "--cached", "--numstat", "--no-ext-diff"
    ).strip()

    binary_paths = set()
    for line in numstat.splitlines():
        fields = line.split("\t", 2)
        if len(fields) == 3 and fields[0] == "-" and fields[1] == "-":
            binary_paths.add(fields[2])

    path_lines = [f"- {path}" for path in files[:40]]
    if len(files) > 40:
        path_lines.append(f"- [{len(files) - 40} additional paths omitted]")

    artifact_lines = []
    for path in files:
        kind = path_kind(path)
        if kind is not None:
            suffix = " (binary)" if path in binary_paths else ""
            artifact_lines.append(f"- {kind}: {path}{suffix}")
        elif path in binary_paths:
            artifact_lines.append(f"- binary file: {path}")

    sections = [
        "Paths:\n" + ("\n".join(path_lines) if path_lines else "[none]"),
        "Status:\n" + (status or "[none]"),
        "Line changes (-/- means binary):\n" + (numstat or "[none]"),
    ]
    if artifact_lines:
        sections.append("Opaque artifact hints:\n" + "\n".join(artifact_lines[:40]))

    context = "\n\n".join(sections)
    if len(context) > MAX_FILE_CONTEXT_CHARS:
        context = (
            context[:MAX_FILE_CONTEXT_CHARS].rstrip()
            + "\n[staged file context truncated]"
        )
    return context


def _clip_diff_section(section: str, budget: int) -> str:
    if len(section) <= budget:
        return section

    marker = "\n...[middle of file diff omitted]...\n"
    if budget <= len(marker) + 80:
        return section[:budget]

    head = int((budget - len(marker)) * 0.7)
    tail = budget - len(marker) - head
    return section[:head] + marker + section[-tail:]


def sample_diff_for_prompt(diff: str) -> str:
    """Sample oversized diffs across files instead of keeping only the prefix."""
    if len(diff) <= MAX_DIFF_CHARS:
        return diff

    starts = [match.start() for match in re.finditer(r"(?m)^diff --git ", diff)]
    if not starts:
        note = "\n[diff sampled to fit prompt]"
        sampled = _clip_diff_section(diff, max(1, MAX_DIFF_CHARS - len(note)))
        return sampled + note

    sections = []
    for index, start in enumerate(starts):
        end = starts[index + 1] if index + 1 < len(starts) else len(diff)
        sections.append(diff[start:end].rstrip())

    if len(sections) > MAX_DIFF_SECTIONS:
        if MAX_DIFF_SECTIONS <= 1:
            selected_indexes = [0]
        else:
            selected_indexes = sorted(
                {
                    round(index * (len(sections) - 1) / (MAX_DIFF_SECTIONS - 1))
                    for index in range(MAX_DIFF_SECTIONS)
                }
            )
        selected = [sections[index] for index in selected_indexes]
        omitted = len(sections) - len(selected)
    else:
        selected = sections
        omitted = 0

    note = "\n[diff sampled across files to fit prompt"
    if omitted:
        note += f"; {omitted} file sections omitted"
    note += "]"

    separator = "\n\n"
    available = max(
        1,
        MAX_DIFF_CHARS - len(note) - len(separator) * (len(selected) - 1),
    )
    per_section = max(1, available // max(1, len(selected)))
    sampled_sections = [
        _clip_diff_section(section, per_section) for section in selected
    ]
    sampled = separator.join(sampled_sections)

    limit = MAX_DIFF_CHARS - len(note)
    if len(sampled) > limit:
        sampled = sampled[:limit].rstrip()
    return sampled + note

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


def prompt_for_diff(stat: str, diff: str, file_context: str = "") -> str:
    sampled = sample_diff_for_prompt(diff)
    history = recent_subjects()
    return f"""Write exactly one Git commit subject for the staged changes below.

Output rules:
- output only the subject line
- maximum 72 characters
- use concise imperative wording
- describe the intent rather than listing files
- no markdown, quotes, explanation, or trailing period
- use staged file context for binary, document, image, and rename changes
- do not invent contents that are not represented in the supplied text
- when the diff is sampled, infer the overall intent from all sampled sections

Recent repository subjects:
{history or "[none]"}

Staged diff stat:
{stat}

Staged file context:
{file_context or "[none]"}

Staged diff:
{sampled}
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
    installed = installed_local_model_names()
    model, low_memory_mode = selected_model(installed)
    primary, low_memory = configured_models()

    if model is None:
        if low_memory_mode:
            detail = (
                f"low-memory model {low_memory} is not installed locally; "
                "using fallback title"
            )
        else:
            detail = (
                f"configured models {primary} and {low_memory} are not installed locally; "
                "using fallback title"
            )
        print(f"scm-toolkit: {detail}", file=sys.stderr)
        return fallback_title(files)

    file_context = staged_file_context(files)
    try:
        response = ollama_json(
            "/api/generate",
            {
                "model": model,
                "prompt": prompt_for_diff(stat, diff, file_context),
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
