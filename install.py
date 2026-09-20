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
CODEX_START = '\n/* scm-toolkit-codex-countdown:start */\n'
CODEX_END = '\n/* scm-toolkit-codex-countdown:end */\n'

DEFAULT_SETTINGS = {
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
        "filledButtons": read_git_bool(
            "scm-toolkit.filled-buttons", DEFAULT_SETTINGS["filledButtons"]
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
        "mcpPullRequest": read_git_bool(
            "scm-toolkit.mcp-pull-request", DEFAULT_SETTINGS["mcpPullRequest"]
        ),
        "mcpPrServer": read_git_string(
            "scm-toolkit.mcp-pr-server", DEFAULT_SETTINGS["mcpPrServer"]
        ),
        "mcpPrTool": read_git_string(
            "scm-toolkit.mcp-pr-tool", DEFAULT_SETTINGS["mcpPrTool"]
        ),
        "codexUsageResetCountdown": read_git_bool(
            "scm-toolkit.codex-usage-reset-countdown",
            DEFAULT_SETTINGS["codexUsageResetCountdown"],
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
    command, notification, configuration, mcp, observe, dimension = "fe", "Le", "Xe", "Me", "pe", "xi"

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
        mcp = unique(r"(" + ident + r')=\w+\("IMcpService"\)')
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
            f"accessor.get({configuration}),accessor.get({mcp}),scmToolkitSettings))}}"
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


def strip_codex_payload(text):
    if CODEX_START not in text:
        return text
    if text.count(CODEX_START) != 1 or text.count(CODEX_END) != 1:
        raise ValueError("Unexpected Codex countdown patch markers; refusing to modify this file.")
    before, rest = text.split(CODEX_START, 1)
    _, after = rest.split(CODEX_END, 1)
    return before + after


def codex_countdown_edit(js):
    matches = []
    pattern = re.compile(
        r"(?P<display>[A-Za-z_$][\w$]*)=(?P<reset>[A-Za-z_$][\w$]*)==null\?null:"
        r"(?P<formatter>[A-Za-z_$][\w$]*)\((?P<intl>[A-Za-z_$][\w$]*),"
        r"(?P=reset),(?P<flag>[A-Za-z_$][\w$]*)\),"
    )
    title = "You’re out of Codex messages"
    for match in pattern.finditer(js):
        if title in js[match.end() : match.end() + 40_000]:
            matches.append(match)

    if len(matches) != 1:
        raise ValueError("Unsupported Codex extension build: reset-time anchor does not match.")

    match = matches[0]
    jsx_match = re.search(
        r"\(0,([A-Za-z_$][\w$]*)\.jsx\)\([^,]+,\{id:"
        r"`codex\.upsellBanner\.general\.title`,defaultMessage:"
        r"`You’re out of Codex messages`",
        js[match.end() : match.end() + 40_000],
    )
    if jsx_match is None:
        raise ValueError("Unsupported Codex extension build: JSX anchor does not match.")

    jsx = jsx_match.group(1)
    original = match.group(0)
    replacement = (
        f'{match.group("display")}={match.group("reset")}==null?null:'
        f'(0,{jsx}.jsx)(`scm-toolkit-usage-reset-countdown`,{{'
        f'"reset-at":{match.group("reset")}'
        '}),'
    )
    return original, replacement


def transform_codex(js, enabled=False, remove=False):
    installed = CODEX_START in js
    if installed:
        payload = js.split(CODEX_START, 1)[1].split(CODEX_END, 1)[0]
        saved = re.search(r"^/\* edit:(.*?) \*/$", payload, re.MULTILINE)
        if saved is None:
            raise ValueError("Installed Codex countdown patch is missing its edit metadata.")
        original, replacement = json.loads(saved.group(1))
        js = strip_codex_payload(js)
        if js.count(replacement) != 1:
            raise ValueError(
                "Installed Codex countdown patch changed; refusing to remove unrelated edits."
            )
        js = js.replace(replacement, original, 1)

    if remove or not enabled:
        return js

    original, replacement = codex_countdown_edit(js)
    if js.count(original) != 1:
        raise ValueError("Unsupported Codex extension build: reset-time anchor is ambiguous.")
    js = js.replace(original, replacement, 1)
    return (
        js
        + CODEX_START
        + "/* edit:"
        + json.dumps([original, replacement])
        + " */\n"
        + (HERE / "codex-countdown.js").read_text()
        + CODEX_END
    )


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


def codex_bundle_path(extension_path=None):
    if extension_path is None:
        extensions = Path.home() / ".vscode/extensions"
        candidates = sorted(extensions.glob("openai.chatgpt-*"), reverse=True)
    else:
        candidates = [extension_path]

    for candidate in candidates:
        assets = candidate / "webview/assets"
        if not assets.is_dir():
            continue
        patched = [
            path
            for path in assets.glob("app-initial-*.js")
            if CODEX_START in path.read_text()
        ]
        if len(patched) == 1:
            return patched[0]
        matches = []
        for path in assets.glob("app-initial-*.js"):
            text = path.read_text()
            if "You’re out of Codex messages" not in text:
                continue
            try:
                codex_countdown_edit(text)
            except ValueError:
                continue
            matches.append(path)
        if len(matches) == 1:
            return matches[0]

    return None


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
    parser.add_argument(
        "--codex-only",
        action="store_true",
        help="Only install or remove the optional Codex usage-reset countdown",
    )
    parser.add_argument(
        "--codex-extension",
        type=Path,
        help="Path to an OpenAI Codex VS Code extension directory",
    )
    args = parser.parse_args()

    settings = load_settings()
    version, workbench_paths = application_paths(args.app)
    paths = [] if args.codex_only else workbench_paths
    old = [path.read_text() for path in paths]
    new = (
        []
        if args.codex_only
        else list(transform(*old, remove=args.uninstall, settings=settings))
    )
    wrapper_path = ai_wrapper_path()
    wrapper_changed = (
        False
        if args.codex_only
        else sync_ai_wrapper(
            remove=args.uninstall, check=True, destination=wrapper_path
        )
    )
    model_picker_path = ai_model_picker_path()
    model_picker_changed = (
        False
        if args.codex_only
        else sync_model_picker(
            enabled=settings["aiModelPicker"],
            remove=args.uninstall,
            check=True,
            destination=model_picker_path,
        )
    )

    codex_path = codex_bundle_path(args.codex_extension)
    should_find_codex = settings["codexUsageResetCountdown"] or args.uninstall
    if codex_path is None and should_find_codex:
        raise ValueError("OpenAI Codex extension webview bundle was not found or is unsupported.")
    if codex_path is not None:
        paths.append(codex_path)
        codex_old = codex_path.read_text()
        old.append(codex_old)
        new.append(
            transform_codex(
                codex_old,
                enabled=settings["codexUsageResetCountdown"],
                remove=args.uninstall,
            )
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
        if not args.codex_only:
            sync_ai_wrapper(remove=args.uninstall, destination=wrapper_path)
            sync_model_picker(
                enabled=settings["aiModelPicker"],
                remove=args.uninstall,
                destination=model_picker_path,
            )

    action = "Validated" if args.check else "Removed" if args.uninstall else "Installed"
    target = "Codex countdown" if args.codex_only else "SCM toolkit"
    print(f"{action} {target} for VS Code {version}. Reload VS Code to apply the change.")
    if not args.codex_only:
        if args.uninstall:
            print("Clear VS Code git.path if it still points to the removed SCM toolkit wrapper.")
        else:
            print(f"AI commit wrapper: {wrapper_path}")
            if settings["aiModelPicker"]:
                print(f"AI model picker: {model_picker_path}")
            else:
                print("AI model picker: disabled by scm-toolkit.ai-model-picker")
            print(
                "Set VS Code git.path to that absolute path and "
                "git.useEditorAsCommitInput to true."
            )


if __name__ == "__main__":
    main()
