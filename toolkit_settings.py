"""Global Git-backed settings shared by the SCM Toolkit installers and UI."""

from __future__ import annotations

import subprocess


DEFAULT_SETTINGS = {
    "branchPicker": True,
    "ponyBranch": True,
    "branchNameDisabledPacks": "",
    "branchCustomNames": "",
    "branchNameImports": "[]",
    "shortPlaceholder": True,
    "sourceControlLabel": "Sweetiebot",
    "workspaceSearchActivityBar": False,
    "workspaceSearchLabel": "EFS",
    "filledButtons": False,
    "commitAndPush": True,
    "branchCleanup": True,
    "autocompleteToggle": True,
    "codexCoauthor": True,
    "hideOutgoingSyncCount": True,
    "blankStateRefresh": True,
    "autoPullClean": True,
    "cmdClickCloseOthers": False,
    "browserChatgptHome": False,
    "graphOpenWorkingFile": True,
    "aiCommit": True,
    "spellcheckManualCommit": True,
    "aiDefaultBranchDescription": True,
    "aiCommitModel": "qwen2.5-coder:7b",
    "aiCommitLowMemoryModel": "qwen2.5-coder:3b",
    "aiLowMemoryGiB": "4",
    "aiModelPicker": True,
    "mcpPullRequest": True,
    "mcpPrServer": "codex-drafter",
    "mcpPrTool": "github_create_pull_request",
    "codexUsageResetCountdown": False,
    "codexHidePromotions": False,
    "chatgptCustomInstructions": "",
    "chatgptWebCodexCoauthor": True,
    "codexHideChatTimestamps": False,
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
    settings = {}
    for name, default in DEFAULT_SETTINGS.items():
        git_key = SETTING_KEYS[name]
        reader = read_git_bool if isinstance(default, bool) else read_git_string
        settings[name] = reader(git_key, default)
    return settings


SETTING_KEYS = {
    "branchPicker": "scm-toolkit.branch-picker",
    "ponyBranch": "scm-toolkit.pony-branch",
    "branchNameDisabledPacks": "scm-toolkit.branch-name-disabled-packs",
    "branchCustomNames": "scm-toolkit.branch-custom-names",
    "branchNameImports": "scm-toolkit.branch-name-imports",
    "shortPlaceholder": "scm-toolkit.short-placeholder",
    "sourceControlLabel": "scm-toolkit.source-control-label",
    "workspaceSearchActivityBar": "scm-toolkit.workspace-search-activity-bar",
    "workspaceSearchLabel": "scm-toolkit.workspace-search-label",
    "filledButtons": "scm-toolkit.filled-buttons",
    "commitAndPush": "scm-toolkit.commit-and-push",
    "branchCleanup": "scm-toolkit.branch-cleanup",
    "autocompleteToggle": "scm-toolkit.autocomplete-toggle",
    "codexCoauthor": "scm-toolkit.codex-coauthor",
    "hideOutgoingSyncCount": "scm-toolkit.hide-outgoing-sync-count",
    "blankStateRefresh": "scm-toolkit.blank-state-refresh",
    "autoPullClean": "scm-toolkit.auto-pull-clean",
    "cmdClickCloseOthers": "scm-toolkit.cmd-click-close-others",
    "browserChatgptHome": "scm-toolkit.browser-chatgpt-home",
    "graphOpenWorkingFile": "scm-toolkit.graph-open-working-file",
    "aiCommit": "scm-toolkit.ai-commit",
    "spellcheckManualCommit": "scm-toolkit.spellcheck-manual-commit",
    "aiDefaultBranchDescription": "scm-toolkit.ai-default-branch-description",
    "aiCommitModel": "scm-toolkit.ai-commit-model",
    "aiCommitLowMemoryModel": "scm-toolkit.ai-commit-low-memory-model",
    "aiLowMemoryGiB": "scm-toolkit.ai-low-memory-gib",
    "aiModelPicker": "scm-toolkit.ai-model-picker",
    "mcpPullRequest": "scm-toolkit.mcp-pull-request",
    "mcpPrServer": "scm-toolkit.mcp-pr-server",
    "mcpPrTool": "scm-toolkit.mcp-pr-tool",
    "codexUsageResetCountdown": "scm-toolkit.codex-usage-reset-countdown",
    "codexHidePromotions": "scm-toolkit.codex-hide-promotions",
    "chatgptCustomInstructions": "scm-toolkit.chatgpt-custom-instructions",
    "chatgptWebCodexCoauthor": "scm-toolkit.chatgpt-web-codex-coauthor",
    "codexHideChatTimestamps": "scm-toolkit.codex-hide-chat-timestamps",
    "defaultBranch": "scm-toolkit.default-branch",
    "remote": "scm-toolkit.remote",
}
