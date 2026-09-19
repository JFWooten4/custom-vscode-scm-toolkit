# Custom VS Code SCM Toolkit

A small source-control UI patch for Visual Studio Code. It keeps the built-in Git workflow, but adds a compact branch selector and optional SCM controls around the commit-message box.

Current features:

- show the current branch inside the SCM message box and open VS Code's normal branch picker from it
- shorten the commit-message placeholder to `Message`
- optionally show a commit-and-push checkbox backed by VS Code's `git.postCommitCommand`
- optionally show a guarded local-branch cleanup button
- optionally hide the outgoing commit count from the built-in Sync action

The patch is intentionally narrow: it does not copy or manage unrelated editor settings.

## Requirements

- macOS
- Visual Studio Code using the standard application-bundle layout
- Python 3
- Git, if you want to configure feature flags through global Git config

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
git config --global scm-toolkit.commit-and-push true
git config --global scm-toolkit.branch-cleanup true
git config --global scm-toolkit.hide-outgoing-sync-count true
git config --global scm-toolkit.default-branch main
git config --global scm-toolkit.remote origin
```

The equivalent `~/.gitconfig` block is:

```gitconfig
[scm-toolkit]
    branch-picker = true
    short-placeholder = true
    commit-and-push = true
    branch-cleanup = true
    hide-outgoing-sync-count = true
    default-branch = main
    remote = origin
```

All five feature switches default to `true`. The default protected branch is `main`, and the default remote is `origin`.

After changing toolkit Git config, rerun:

```sh
python3 install.py
```

Then reload Visual Studio Code. The installer resolves the Git-config values and embeds that configuration into the installed patch.

### Commit and push

When `commit-and-push` is enabled, the checkbox mirrors VS Code's `git.postCommitCommand` setting. Checking it sets the value to `push`; unchecking it sets the value to `none`.

Disabling the toolkit feature hides the checkbox. It does not silently rewrite an existing `git.postCommitCommand` value.

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

Remove the patch:

```sh
python3 install.py --uninstall
```

Then reload or restart Visual Studio Code.

You can also use `--check` with `--uninstall` to validate the removal without writing:

```sh
python3 install.py --uninstall --check
```
