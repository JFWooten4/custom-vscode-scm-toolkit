// Runs inside VS Code's SCM input widget; services and observables are supplied by install.py.
function scmToolkitCreateControls(widget, observe, commands, notifications, configuration, settings) {
    const doc = widget.element.ownerDocument;
    const branchButton = doc.createElement('button');
    branchButton.type = 'button';
    branchButton.className = 'scm-toolkit-branch';
    branchButton.hidden = true;

    const branchLabel = doc.createElement('span');
    branchLabel.className = 'scm-toolkit-branch-label';

    const arrow = doc.createElement('span');
    arrow.textContent = '▾';
    arrow.setAttribute('aria-hidden', 'true');

    branchButton.append(branchLabel, arrow);

    const pushControl = doc.createElement('label');
    pushControl.className = 'scm-toolkit-push';
    pushControl.hidden = true;
    pushControl.title = 'Commit and push after a successful commit';

    const pushCheckbox = doc.createElement('input');
    pushCheckbox.type = 'checkbox';
    pushCheckbox.className = 'scm-toolkit-push-checkbox';
    pushCheckbox.setAttribute('aria-label', 'Commit and push');

    const pushMark = doc.createElement('span');
    pushMark.className = 'scm-toolkit-push-mark';
    pushMark.setAttribute('aria-hidden', 'true');

    pushControl.append(pushCheckbox, pushMark);

    const deleteButton = doc.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'scm-toolkit-delete-branch codicon codicon-trash';
    deleteButton.hidden = true;

    widget.element.prepend(branchButton);
    widget.element.append(pushControl, deleteButton);

    let currentCommand;
    let currentBranch;
    let currentHistoryProvider;
    let currentRepositoryArgument;
    let pending = false;
    let deletingBranch = false;
    let updatingPush = false;

    const refreshPush = () => {
        pushCheckbox.checked = configuration.getValue('git.postCommitCommand') === 'push';
    };

    const changePush = async event => {
        event.stopPropagation();
        if (updatingPush) return;

        updatingPush = true;
        pushCheckbox.disabled = true;
        const enabled = pushCheckbox.checked;
        try {
            await configuration.updateValue(
                'git.postCommitCommand',
                enabled ? 'push' : 'none'
            );
        } catch (error) {
            notifications.error(error);
        } finally {
            updatingPush = false;
            pushCheckbox.disabled = deletingBranch;
            refreshPush();
        }
    };

    pushCheckbox.addEventListener('change', changePush);
    widget.disposables.add(configuration.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('git.postCommitCommand')) refreshPush();
    }));

    const refreshBranchControls = () => {
        branchButton.disabled = pending || deletingBranch || !currentCommand?.id;

        const unavailable =
            !settings.branchCleanup
            || !currentBranch
            || !currentHistoryProvider
            || !currentRepositoryArgument;

        deleteButton.hidden = !settings.branchCleanup || !currentBranch;
        deleteButton.disabled =
            pending
            || deletingBranch
            || unavailable
            || currentBranch === settings.defaultBranch;

        if (!currentBranch) {
            deleteButton.title = '';
            deleteButton.removeAttribute('aria-label');
        } else if (currentBranch === settings.defaultBranch) {
            const description = `${settings.defaultBranch} cannot be deleted`;
            deleteButton.title = description;
            deleteButton.setAttribute('aria-label', description);
        } else {
            const description =
                `Delete local branch ${currentBranch} if it no longer exists on ${settings.remote}`;
            deleteButton.title = description;
            deleteButton.setAttribute('aria-label', description);
        }
    };

    const openBranchPicker = async event => {
        event.stopPropagation();
        const command = currentCommand;
        if (!command?.id || pending || deletingBranch) return;

        pending = true;
        refreshBranchControls();
        try {
            await commands.executeCommand(command.id, ...(command.arguments ?? []));
        } catch (error) {
            notifications.error(error);
        } finally {
            pending = false;
            refreshBranchControls();
        }
    };

    const deleteBranch = async event => {
        event.stopPropagation();

        const branch = currentBranch;
        const historyProvider = currentHistoryProvider;
        const repositoryArgument = currentRepositoryArgument;

        if (
            !settings.branchCleanup
            || !branch
            || !historyProvider
            || !repositoryArgument
            || deletingBranch
            || pending
        ) {
            return;
        }

        if (branch === settings.defaultBranch) {
            notifications.error(`Cannot delete ${settings.defaultBranch}.`);
            return;
        }

        deletingBranch = true;
        pushCheckbox.disabled = true;
        refreshBranchControls();

        try {
            await commands.executeCommand('git.fetchPrune', repositoryArgument);

            const remotePrefix = `refs/remotes/${settings.remote}`;
            const remoteRefs = await historyProvider.provideHistoryItemRefs([remotePrefix]);

            if (!Array.isArray(remoteRefs) || remoteRefs.length === 0) {
                notifications.error(
                    `Cannot delete ${branch}: ${settings.remote} could not be verified.`
                );
                return;
            }

            if (remoteRefs.some(ref => ref.id === `${remotePrefix}/${branch}`)) {
                notifications.error(
                    `Cannot delete ${branch}: it still exists on ${settings.remote}.`
                );
                return;
            }

            await commands.executeCommand(
                'git.checkout',
                repositoryArgument,
                settings.defaultBranch
            );
            await commands.executeCommand('git.deleteBranch', repositoryArgument, branch);
            await commands.executeCommand('git.sync', repositoryArgument);
        } catch (error) {
            notifications.error(error);
        } finally {
            deletingBranch = false;
            pushCheckbox.disabled = updatingPush;
            refreshBranchControls();
        }
    };

    branchButton.addEventListener('click', openBranchPicker);
    deleteButton.addEventListener('click', deleteBranch);
    widget.disposables.add({
        dispose() {
            branchButton.removeEventListener('click', openBranchPicker);
            deleteButton.removeEventListener('click', deleteBranch);
            pushCheckbox.removeEventListener('change', changePush);
            branchButton.remove();
            pushControl.remove();
            deleteButton.remove();
        }
    });

    return {
        width() {
            const branchWidth = branchButton.hidden
                ? 0
                : branchButton.getBoundingClientRect().width;
            const pushWidth = pushControl.hidden
                ? 0
                : pushControl.getBoundingClientRect().width;
            const deleteWidth = deleteButton.hidden
                ? 0
                : deleteButton.getBoundingClientRect().width;
            return branchWidth + pushWidth + deleteWidth;
        },

        bind(input) {
            currentCommand = undefined;
            currentBranch = undefined;
            currentHistoryProvider = undefined;
            currentRepositoryArgument = undefined;
            branchButton.hidden = true;
            branchButton.disabled = true;
            pushControl.hidden = true;
            deleteButton.hidden = true;
            deleteButton.disabled = true;

            if (!input || input.repository.provider.providerId !== 'git') return;

            if (settings.commitAndPush) {
                pushControl.hidden = false;
                refreshPush();
            }

            if (settings.shortPlaceholder) {
                const keepMessagePlaceholderShort = () => {
                    if (input.placeholder !== 'Message') input.placeholder = 'Message';
                };
                keepMessagePlaceholderShort();
                widget.repositoryDisposables.add(
                    input.onDidChangePlaceholder(keepMessagePlaceholderShort)
                );
            }

            const provider = input.repository.provider;
            widget.repositoryDisposables.add(observe(reader => {
                const items = provider.statusBarCommands.read(reader) ?? [];
                // Keep the first Git status command and its original arguments so the
                // built-in branch picker remains the source of truth.
                const command = items[0];
                currentCommand = command;
                currentRepositoryArgument = command?.arguments?.[0];

                const historyProvider = provider.historyProvider.read(reader);
                const historyItemRef = historyProvider?.historyItemRef.read(reader);
                currentHistoryProvider = historyProvider;
                currentBranch = historyItemRef?.id?.startsWith('refs/heads/')
                    ? historyItemRef.name
                    : undefined;

                const branch = command?.title?.replace(/\$\([^)]+\)/g, '').trim();
                branchButton.hidden = !settings.branchPicker || !branch;
                branchLabel.textContent = branch ?? '';
                branchButton.title = command?.tooltip || `Select branch: ${branch ?? ''}`;
                branchButton.setAttribute('aria-label', `Select branch, current branch ${branch ?? ''}`);
                refreshBranchControls();
                widget.layout();
            }));
        }
    };
}
