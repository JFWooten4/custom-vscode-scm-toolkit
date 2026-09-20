#!/usr/bin/env python3
"""Apply, validate, or remove the custom VS Code SCM toolkit patch."""

import argparse
import json
import os
import re
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
START = '\n/* scm-toolkit:start */\n'
END = '\n/* scm-toolkit:end */\n'

DEFAULT_SETTINGS = {
    "branchPicker": True,
    "shortPlaceholder": True,
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
    "defaultBranch": "main",
    "remote": "origin",
}


def read_git_bool(key, default):
    try:
        result = subprocess.run(
            ["git", "config", "--global", "--type=bool", "--get", key],
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        return default

    if result.returncode == 1:
        return default
    if result.returncode != 0:
        raise RuntimeError(f"Unable to read global Git config key {key}: {result.stderr.strip()}")
    return result.stdout.strip() == "true"


def read_git_string(key, default):
    try:
        result = subprocess.run(
            ["git", "config", "--global", "--get", key],
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        return default

    if result.returncode == 1:
        return default
    if result.returncode != 0:
        raise RuntimeError(f"Unable to read global Git config key {key}: {result.stderr.strip()}")
    value = result.stdout.strip()
    return value or default


def load_settings():
    return {
        "branchPicker": read_git_bool("scm-toolkit.branch-picker", DEFAULT_SETTINGS["branchPicker"]),
        "shortPlaceholder": read_git_bool(
            "scm-toolkit.short-placeholder", DEFAULT_SETTINGS["shortPlaceholder"]
        ),
        "commitAndPush": read_git_bool(
            "scm-toolkit.commit-and-push", DEFAULT_SETTINGS["commitAndPush"]
        ),
        "branchCleanup": read_git_bool(
            "scm-toolkit.branch-cleanup", DEFAULT_SETTINGS["branchCleanup"]
        ),
        "autocompleteToggle": read_git_bool(
            "scm-toolkit.autocomplete-toggle", DEFAULT_SETTINGS["autocompleteToggle"]
        ),
        "codexCoauthor": read_git_bool(
            "scm-toolkit.codex-coauthor", DEFAULT_SETTINGS["codexCoauthor"]
        ),
        "hideOutgoingSyncCount": read_git_bool(
            "scm-toolkit.hide-outgoing-sync-count",
            DEFAULT_SETTINGS["hideOutgoingSyncCount"],
        ),
        "blankStateRefresh": read_git_bool(
            "scm-toolkit.blank-state-refresh",
            DEFAULT_SETTINGS["blankStateRefresh"],
        ),
        "aiCommit": read_git_bool(
            "scm-toolkit.ai-commit", DEFAULT_SETTINGS["aiCommit"]
        ),
        "aiDefaultBranchDescription": read_git_bool(
            "scm-toolkit.ai-default-branch-description",
            DEFAULT_SETTINGS["aiDefaultBranchDescription"],
        ),
        "aiCommitModel": read_git_string(
            "scm-toolkit.ai-commit-model", DEFAULT_SETTINGS["aiCommitModel"]
        ),
        "aiCommitLowMemoryModel": read_git_string(
            "scm-toolkit.ai-commit-low-memory-model",
            DEFAULT_SETTINGS["aiCommitLowMemoryModel"],
        ),
        "aiLowMemoryGiB": read_git_string(
            "scm-toolkit.ai-low-memory-gib", DEFAULT_SETTINGS["aiLowMemoryGiB"]
        ),
        "aiModelPicker": read_git_bool(
            "scm-toolkit.ai-model-picker", DEFAULT_SETTINGS["aiModelPicker"]
        ),
        "defaultBranch": read_git_string(
            "scm-toolkit.default-branch", DEFAULT_SETTINGS["defaultBranch"]
        ),
        "remote": read_git_string("scm-toolkit.remote", DEFAULT_SETTINGS["remote"]),
    }


def ai_wrapper_path():
    configured = os.environ.get(
        "SCM_TOOLKIT_AI_WRAPPER_PATH", "~/.local/bin/scm-toolkit-git"
    )
    return Path(configured).expanduser()


def sync_ai_wrapper(remove=False, check=False, destination=None):
    destination = Path(destination) if destination is not None else ai_wrapper_path()
    source = HERE / "ai_commit.py"

    if remove:
        changed = destination.exists() or destination.is_symlink()
        if changed and not check:
            destination.unlink()
        return changed

    if destination.is_symlink():
        raise RuntimeError(f"Refusing to overwrite symlinked AI wrapper: {destination}")

    expected = source.read_bytes()
    current = destination.read_bytes() if destination.exists() else None
    executable = destination.exists() and bool(destination.stat().st_mode & 0o111)
    changed = current != expected or not executable

    if changed and not check:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(expected)
        destination.chmod(0o755)

    return changed


def ai_model_picker_path():
    configured = os.environ.get(
        "SCM_TOOLKIT_MODEL_PICKER_PATH", "~/.local/bin/scm-toolkit-models"
    )
    return Path(configured).expanduser()


def sync_model_picker(enabled=True, remove=False, check=False, destination=None):
    destination = (
        Path(destination) if destination is not None else ai_model_picker_path()
    )
    source = HERE / "model_picker.py"
    should_remove = remove or not enabled

    if should_remove:
        changed = destination.exists() or destination.is_symlink()
        if changed and not check:
            destination.unlink()
        return changed

    if destination.is_symlink():
        raise RuntimeError(f"Refusing to overwrite symlinked model picker: {destination}")

    expected = source.read_bytes()
    current = destination.read_bytes() if destination.exists() else None
    executable = destination.exists() and bool(destination.stat().st_mode & 0o111)
    changed = current != expected or not executable

    if changed and not check:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(expected)
        destination.chmod(0o755)

    return changed


def edits(js=None):
    command, notification, configuration, observe, dimension = "fe", "Le", "Xe", "pe", "xi"

    if js is not None:
        ident = r"[A-Za-z_$][\w$]*"

        def unique(pattern):
            matches = re.findall(pattern, js)
            if len(matches) != 1:
                raise ValueError("Unsupported VS Code build: internal API does not match.")
            return matches[0]

        command = unique(r"(" + ident + r')=\w+\("commandService"\)')
        notification = unique(r"(" + ident + r')=\w+\("notificationService"\)')
        configuration = unique(r"(" + ident + r')=\w+\("configurationService"\)')
        observe = unique(
            r"function (" + ident + r")\(s,o=" + ident
            + r"\.ofCaller\(\)\)\{return new " + ident
            + r"\(new " + ident + r"\(void 0,void 0,s\),s,void 0,o\)\}"
        )
        dimension = unique(
            r"t=new (" + ident + r")\(this\.element\.clientWidth-e,o\);if\(t\.width<0\)"
        )

    return [
        (
            "this.disposables.add(this.toolbar)}static{this.ValidationTimeouts=",
            "this.disposables.add(this.toolbar);this.scmToolkitControls="
            f"i.invokeFunction(accessor=>scmToolkitCreateControls(this,{observe},"
            f"accessor.get({command}),accessor.get({notification}),"
            f"accessor.get({configuration}),scmToolkitSettings))}}"
            "static{this.ValidationTimeouts=",
        ),
        (
            "this.inputEditor.setModel(void 0),this.model=void 0;return}"
            "let e=o.repository.provider.inputBoxTextModel;",
            "this.inputEditor.setModel(void 0),this.model=void 0;"
            "this.scmToolkitControls.bind(void 0);return}"
            "let e=o.repository.provider.inputBoxTextModel;",
        ),
        (
            "this.toolbar.setInput(o),this.model={input:o,textModel:e}}get selections()",
            "this.toolbar.setInput(o),this.model={input:o,textModel:e};"
            "this.scmToolkitControls.bind(o)}get selections()",
        ),
        (
            f"t=new {dimension}(this.element.clientWidth-e,o);if(t.width<0)",
            f"t=new {dimension}(this.element.clientWidth-e-"
            "(this.scmToolkitControls?.width()??0),o);if(t.width<0)",
        ),
    ]


def strip_payload(text):
    if START not in text:
        return text
    if text.count(START) != 1 or text.count(END) != 1:
        raise ValueError("Unexpected toolkit patch markers; refusing to modify this file.")
    before, rest = text.split(START, 1)
    _, after = rest.split(END, 1)
    return before + after


def transform(js, css, remove=False, settings=None):
    installed = START in js
    if installed != (START in css):
        raise ValueError("Incomplete toolkit installation; refusing to overwrite it.")

    if installed:
        payload = js.split(START, 1)[1].split(END, 1)[0]
        saved = re.search(r"^/\* edits:(.*?) \*/$", payload, re.MULTILINE)
        previous = json.loads(saved.group(1)) if saved else edits()
        js, css = strip_payload(js), strip_payload(css)

        for original, replacement in previous:
            if js.count(replacement) != 1:
                raise ValueError(
                    "Installed toolkit patch changed; refusing to remove unrelated edits."
                )
            js = js.replace(replacement, original, 1)

    if remove:
        return js, css

    changes = edits(js)
    for original, replacement in changes:
        if js.count(original) != 1:
            raise ValueError("Unsupported VS Code build: SCM widget anchor does not match.")
        js = js.replace(original, replacement, 1)

    settings = load_settings() if settings is None else settings
    js += (
        START
        + "const scmToolkitSettings = "
        + json.dumps(settings, separators=(",", ":"))
        + ";\n"
        + "/* edits:"
        + json.dumps(changes)
        + " */\n"
        + (HERE / "picker.js").read_text()
        + END
    )
    css += START + (HERE / "picker.css").read_text() + END
    return js, css


def application_paths(app_path):
    app = app_path / "Contents/Resources/app"
    package = app / "package.json"
    version = json.loads(package.read_text())["version"]
    workbench = app / "out/vs/workbench"
    return version, [
        workbench / "workbench.desktop.main.js",
        workbench / "workbench.desktop.main.css",
    ]


def write_pair(paths, new_contents, old_contents):
    written = []
    try:
        for path, content, original in zip(paths, new_contents, old_contents):
            written.append((path, original))
            path.write_text(content)
    except OSError:
        for path, original in written:
            try:
                path.write_text(original)
            except OSError:
                pass
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--app",
        type=Path,
        default=Path("/Applications/Visual Studio Code.app"),
        help="Path to the Visual Studio Code application bundle",
    )
    parser.add_argument("--uninstall", action="store_true", help="Remove the toolkit patch")
    parser.add_argument("--check", action="store_true", help="Validate without writing")
    args = parser.parse_args()

    settings = load_settings()
    version, paths = application_paths(args.app)
    old = [path.read_text() for path in paths]
    new = transform(*old, remove=args.uninstall, settings=settings)
    wrapper_path = ai_wrapper_path()
    wrapper_changed = sync_ai_wrapper(
        remove=args.uninstall, check=True, destination=wrapper_path
    )
    model_picker_path = ai_model_picker_path()
    model_picker_changed = sync_model_picker(
        enabled=settings["aiModelPicker"],
        remove=args.uninstall,
        check=True,
        destination=model_picker_path,
    )

    if old == list(new) and not wrapper_changed and not model_picker_changed:
        action = "not installed" if args.uninstall else "already up to date"
        print(f"SCM toolkit is {action} for VS Code {version}.")
        return

    if not args.check:
        if old != list(new):
            if old != [path.read_text() for path in paths]:
                raise RuntimeError("VS Code changed during validation; retry the command.")
            write_pair(paths, new, old)
        sync_ai_wrapper(remove=args.uninstall, destination=wrapper_path)
        sync_model_picker(
            enabled=settings["aiModelPicker"],
            remove=args.uninstall,
            destination=model_picker_path,
        )

    action = "Validated" if args.check else "Removed" if args.uninstall else "Installed"
    print(f"{action} SCM toolkit for VS Code {version}. Reload VS Code to apply the change.")
    if args.uninstall:
        print("Clear VS Code git.path if it still points to the removed SCM toolkit wrapper.")
    else:
        print(f"AI commit wrapper: {wrapper_path}")
        if settings["aiModelPicker"]:
            print(f"AI model picker: {model_picker_path}")
        else:
            print("AI model picker: disabled by scm-toolkit.ai-model-picker")
        print("Set VS Code git.path to that absolute path and git.useEditorAsCommitInput to true.")


if __name__ == "__main__":
    main()
