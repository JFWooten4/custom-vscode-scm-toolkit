# Custom VS Code SCM Toolkit

A small source-control UI patch for Visual Studio Code. It keeps the built-in Git workflow, but adds a compact branch selector and optional SCM controls around the commit-message box.

Current features:

- show the current branch inside the SCM message box and open VS Code's normal branch picker from it
- switch the branch selector and native Commit button between outlined and accent-filled styles
- shorten the commit-message placeholder to `Message`
- optionally show a commit-and-push checkbox backed by VS Code's `git.postCommitCommand`
- optionally show a guarded local-branch cleanup button
- optionally show a quick toggle for VS Code inline autocomplete
- optionally show a commit button that appends the Codex Web co-author trailer
- optionally open a pull request for the current branch through a configured MCP server
- optionally hide the outgoing commit count from the built-in Sync action
- optionally refresh clean/blank Git repositories more aggressively so the first new change appears in SCM quickly
- optionally generate a commit subject locally when the normal Commit button is used with a blank message
- optionally show a live, minute-precision countdown in Codex usage-limit banners

The patch is intentionally narrow: it does not copy or manage unrelated editor settings.

## Requirements

- macOS
- Visual Studio Code using the standard application-bundle layout
- Python 3
- Git, if you want to configure feature flags through global Git config
- Ollama is required for local AI commit-title generation; the rest of the toolkit can be used without it

The installer modifies the installed VS Code workbench files. VS Code updates can replace those files, so rerun the installer after an update if the patch disappears. VS Code may also show an installation-integrity warning after its application files are modified.

## Install

Clone the repository and enter it:

```sh
git clone https://github.com/JFWooten4/custom-vscode-scm-toolkit.git
cd custom-vscode-scm-toolkit
```

Validate that the currently installed VS Code build matches the guarded patch anchors without changing anything:

```sh
python3 install.py --check
```

Install the patch:

```sh
python3 install.py
```

Then reload or restart Visual Studio Code.

The default application path is:

```text
/Applications/Visual Studio Code.app
```

To target another app bundle, pass `--app`:

```sh
python3 install.py --app "/path/to/Visual Studio Code.app"
```

If macOS blocks the write, allow the terminal or Python process you are using under **System Settings → Privacy & Security → App Management**, then run the installer again.

## Configuration

Toolkit settings live in your global Git config under the `scm-toolkit` section. This keeps feature settings in the normal `~/.gitconfig` file and leaves room for new options later.

Set options with `git config --global`:

```sh
git config --global scm-toolkit.branch-picker true
git config --global scm-toolkit.short-placeholder true
git config --global scm-toolkit.filled-buttons false
git config --global scm-toolkit.commit-and-push true
git config --global scm-toolkit.branch-cleanup true
git config --global scm-toolkit.autocomplete-toggle true
git config --global scm-toolkit.codex-coauthor true
git config --global scm-toolkit.hide-outgoing-sync-count true
git config --global scm-toolkit.blank-state-refresh true
git config --global scm-toolkit.ai-commit true
git config --global scm-toolkit.ai-default-branch-description true
git config --global scm-toolkit.ai-commit-model qwen2.5-coder:7b
git config --global scm-toolkit.ai-commit-low-memory-model qwen2.5-coder:3b
git config --global scm-toolkit.ai-low-memory-gib 4
git config --global scm-toolkit.ai-model-picker true
git config --global scm-toolkit.mcp-pull-request true
git config --global scm-toolkit.mcp-pr-server codex-drafter
git config --global scm-toolkit.mcp-pr-tool github_create_pull_request
git config --global scm-toolkit.codex-usage-reset-countdown true
git config --global scm-toolkit.default-branch main
git config --global scm-toolkit.remote origin
```

The equivalent `~/.gitconfig` block is:

```gitconfig
[scm-toolkit]
    branch-picker = true
    short-placeholder = true
    filled-buttons = false
    commit-and-push = true
    branch-cleanup = true
    autocomplete-toggle = true
    codex-coauthor = true
    hide-outgoing-sync-count = true
    blank-state-refresh = true
    ai-commit = true
    ai-default-branch-description = true
    ai-commit-model = qwen2.5-coder:7b
    ai-commit-low-memory-model = qwen2.5-coder:3b
    ai-low-memory-gib = 4
    ai-model-picker = true
    mcp-pull-request = true
    mcp-pr-server = codex-drafter
    mcp-pr-tool = github_create_pull_request
    codex-usage-reset-countdown = true
    default-branch = main
    remote = origin
```

The filled-button style and Codex usage-reset countdown default to `false`; the other twelve SCM feature switches default to `true`. With filled buttons disabled, the branch selector and native Commit button use a transparent background and a theme-aware border instead of VS Code's accent fill. The default AI models are `qwen2.5-coder:7b` for normal operation and `qwen2.5-coder:3b` for low-memory operation. The low-memory threshold defaults to 4 GiB of estimated available memory. The default protected branch is `main`, and the default remote is `origin`.

After changing toolkit Git config, rerun:

```sh
python3 install.py
```

Then reload Visual Studio Code. The installer resolves the Git-config values and embeds that configuration into the installed patch.

### AI commit titles

The installer places a Git wrapper at `~/.local/bin/scm-toolkit-git`. To make VS Code use it, set these User Settings and reload VS Code:

```json
{
    "git.path": "/absolute/path/to/.local/bin/scm-toolkit-git",
    "git.useEditorAsCommitInput": true
}
```

Use the absolute path shown by `python3 install.py`; do not rely on `~` expansion in the setting.

When `ai-commit` is enabled, clicking VS Code's normal Commit button with a blank message summarizes the staged diff through the configured local Ollama model. On the configured `default-branch` (normally `main`), `ai-default-branch-description = true` asks the model for a subject plus one or two substantive sentences describing what changed and, when clear from the diff, its purpose or effect. Other branches keep the subject-only format. A manually entered message, amend/fixup/squash/reuse-message mode, path-limited commit, or `--all` keeps normal Git behavior.

**Ollama is required for this feature.** Run a local Ollama server and install the models you select before relying on AI-generated subjects. The wrapper talks only to Ollama on `127.0.0.1:11434`, bypasses proxy settings for that local request, and checks the local model inventory before generation. If the selected model or Ollama is unavailable, it uses a deterministic fallback subject. The prompt is generic and repository-scoped.

The wrapper supports two independently configurable models:

- `ai-commit-model` is the normal/default model
- `ai-commit-low-memory-model` is used when macOS reports less available memory than `ai-low-memory-gib`

The low-memory path never escalates to the larger primary model when the fallback is missing. During normal-memory operation, the smaller model may be used if the primary model is not installed.

### AI model picker

When `ai-model-picker` is enabled, the installer adds a small native macOS picker:

```sh
~/.local/bin/scm-toolkit-models
```

The picker shows the current selections, locally installed Ollama models, and common Qwen2.5-Coder sizes, then writes the chosen normal and low-memory models to the `[scm-toolkit]` section of `~/.gitconfig`. It does not modify unrelated Git or VS Code settings.

The recommendations are heuristics based on total system memory:

| System memory | Suggested normal model | Suggested low-memory model |
| --- | --- | --- |
| under 12 GiB | `qwen2.5-coder:3b` | `qwen2.5-coder:1.5b` |
| 12–23 GiB | `qwen2.5-coder:7b` | `qwen2.5-coder:3b` |
| 24–47 GiB | `qwen2.5-coder:14b` | `qwen2.5-coder:7b` |
| 48 GiB or more | `qwen2.5-coder:32b` | `qwen2.5-coder:14b` |

These are starting points rather than memory guarantees. Ollama publishes Qwen2.5-Coder variants at 0.5B, 1.5B, 3B, 7B, 14B, and 32B: https://ollama.com/library/qwen2.5-coder

Disable generation without removing the wrapper:

```sh
git config --global scm-toolkit.ai-commit false
```

Keep AI subjects but disable the extra default-branch description:

```sh
git config --global scm-toolkit.ai-default-branch-description false
```

Disable and remove the installed picker on the next installer run:

```sh
git config --global scm-toolkit.ai-model-picker false
python3 install.py
```

The environment variables `SCM_TOOLKIT_AI_MODEL`, `SCM_TOOLKIT_AI_LOW_MEMORY_MODEL`, and `SCM_TOOLKIT_AI_LOW_MEMORY_GIB` can temporarily override the corresponding Git-config values.

### Codex usage-reset countdown

When `codex-usage-reset-countdown` is enabled, usage-limit banners in the installed
Codex extension show the time remaining as a live countdown such as `4h 23m`. The
display rounds to the nearest minute and refreshes as the countdown changes.

To install or refresh only this optional Codex patch without touching the SCM
workbench patch, run:

```sh
python3 install.py --codex-only
```

Codex extension updates can replace the patched webview bundle. Rerun the command
after an extension update if the countdown disappears.

### Commit and push

When `commit-and-push` is enabled, the checkbox mirrors VS Code's `git.postCommitCommand` setting. Checking it sets the value to `push`; unchecking it sets the value to `none`.

Disabling the toolkit feature hides the checkbox. It does not silently rewrite an existing `git.postCommitCommand` value.

### Autocomplete toggle

When `autocomplete-toggle` is enabled, the sparkle button appears after the other
SCM controls. It toggles VS Code's `editor.inlineSuggest.enabled` setting. A slash
through the sparkle means inline autocomplete is off.

### Blank-state refresh

When `blank-state-refresh` is enabled, the toolkit asks VS Code's built-in Git
extension to refresh a repository more aggressively while SCM has zero changed
resources. It performs an initial refresh after about 300 ms, then falls back to
roughly 1.5-second refreshes while VS Code is visible. The polling stops as soon
as SCM reports a change and automatically resumes after the repository becomes
clean again. Hidden windows back off instead of polling at the foreground rate.

This uses VS Code's existing `git.refresh` command; the toolkit does not run its
own Git status implementation.

### Codex co-author commit

When `codex-coauthor` is enabled, an account button appears in the SCM message row.
It appends this trailer to the current message and then runs VS Code's normal
`git.commit` command:

```text
Co-authored-by: Codex Web <noreply@openai.com>
```

The trailer is added after a blank line and is not duplicated if it is already
present. If the commit fails and VS Code leaves the message untouched, the toolkit
restores the original message.

### MCP pull requests

When `mcp-pull-request` is enabled, a pull-request button appears at the end of
the SCM message row for non-default branches. The control resolves the current
GitHub repository from the configured `remote`, finds the MCP server named by
`mcp-pr-server` in VS Code, starts it if necessary, and calls the tool named by
`mcp-pr-tool`.

The defaults target Codex Drafter's `github_create_pull_request` tool. The
tool receives the current GitHub owner/repository, branch as `head`, the
configured `default-branch` as `base`, a title derived from the branch name,
and a minimal generated prompt/body. Authentication and transport stay owned by
VS Code's MCP configuration rather than the SCM patch.

### Branch cleanup

When `branch-cleanup` is enabled, the trash control appears for local branches other than the configured `default-branch`.

Before deletion, the control:

1. fetches with prune
2. verifies that the current branch no longer exists under `refs/remotes/<remote>/`
3. refuses to delete if the configured remote cannot be verified
4. checks out the configured default branch
5. asks VS Code to delete the old local branch without forcing
6. syncs the checked-out default branch

This does not delete the remote branch.

## Uninstall

Before uninstalling, clear VS Code's `git.path` setting if it points to the toolkit wrapper.

Remove the patch and the installed wrapper:

```sh
python3 install.py --uninstall
```

Then reload or restart Visual Studio Code.

You can also use `--check` with `--uninstall` to validate the removal without writing:

```sh
python3 install.py --uninstall --check
```
