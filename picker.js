// Runs inside VS Code's SCM input widget; services and observables are supplied by install.py.
function scmToolkitHideOutgoingSyncCount(widget) {
    const root = widget.element.closest('.scm-view');
    const Observer = widget.element.ownerDocument.defaultView?.MutationObserver;
    if (!root || !Observer) return;

    const observedRoots = globalThis.__scmToolkitOutgoingSyncRoots ??= new WeakSet();
    if (observedRoots.has(root)) return;
    observedRoots.add(root);

    const update = () => {
        for (const action of root.querySelectorAll('.button-container .monaco-button')) {
            if (!action.querySelector('.codicon-sync')) continue;

            for (const upArrow of action.querySelectorAll(
                '.monaco-button-label > .codicon-arrow-up, '
                + '.monaco-button-label-short > .codicon-arrow-up'
            )) {
                const count = upArrow.previousElementSibling;
                if (!count || count.classList.contains('codicon')) continue;

                const text = count.textContent ?? '';
                const withoutOutgoingCount = text.replace(/\s*\d+\s*$/, '').trimEnd();
                if (withoutOutgoingCount === text) continue;

                count.textContent = withoutOutgoingCount;
                count.hidden = withoutOutgoingCount.trim() === '';
            }
        }
    };

    update();
    const observer = new Observer(update);
    observer.observe(root, { subtree: true, childList: true, characterData: true });
}

function scmToolkitEnableBlankStateRefresh(widget, input, commands, repositoryArgument) {
    const doc = widget.element.ownerDocument;
    const win = doc.defaultView;
    const provider = input.repository.provider;
    if (!win || !repositoryArgument || typeof provider.onDidChangeResources !== 'function') return;

    let timer;
    let refreshing = false;
    let disposed = false;

    const hasChanges = () => provider.groups.some(group => group.resources.length > 0);

    const clearTimer = () => {
        if (timer === undefined) return;
        win.clearTimeout(timer);
        timer = undefined;
    };

    const schedule = delay => {
        clearTimer();
        if (disposed || hasChanges()) return;

        timer = win.setTimeout(async () => {
            timer = undefined;
            if (disposed || hasChanges()) return;

            if (doc.hidden) {
                schedule(5000);
                return;
            }

            refreshing = true;
            try {
                await commands.executeCommand('git.refresh', repositoryArgument);
            } catch {
                // The built-in Git extension owns refresh errors; keep blank-state polling best-effort.
            } finally {
                refreshing = false;
                if (!disposed && !hasChanges()) schedule(1500);
            }
        }, delay);
    };

    const resourceDisposable = provider.onDidChangeResources(() => {
        if (disposed) return;

        if (hasChanges()) {
            clearTimer();
            return;
        }

        if (!refreshing && timer === undefined) schedule(300);
    });

    const onVisibilityChange = () => {
        if (disposed || hasChanges() || doc.hidden) return;
        if (!refreshing && timer === undefined) schedule(300);
    };

    doc.addEventListener('visibilitychange', onVisibilityChange);
    schedule(300);

    return {
        dispose() {
            disposed = true;
            clearTimer();
            resourceDisposable.dispose();
            doc.removeEventListener('visibilitychange', onVisibilityChange);
        }
    };
}

function scmToolkitCreateControls(widget, observe, commands, notifications, configuration, settings) {
    const doc = widget.element.ownerDocument;
    if (settings.hideOutgoingSyncCount) scmToolkitHideOutgoingSyncCount(widget);
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

    const deleteTooltip = doc.createElement('span');
    deleteTooltip.className = 'scm-toolkit-tooltip';
    deleteTooltip.setAttribute('aria-hidden', 'true');
    deleteButton.append(deleteTooltip);

    const autocompleteButton = doc.createElement('button');
    autocompleteButton.type = 'button';
    autocompleteButton.className = 'scm-toolkit-autocomplete codicon codicon-sparkle';
    autocompleteButton.hidden = true;

    const autocompleteTooltip = doc.createElement('span');
    autocompleteTooltip.className = 'scm-toolkit-tooltip';
    autocompleteTooltip.setAttribute('aria-hidden', 'true');
    autocompleteButton.append(autocompleteTooltip);

    widget.element.prepend(branchButton);
    widget.element.append(pushControl, deleteButton, autocompleteButton);

    let currentCommand;
    let currentBranch;
    let currentHistoryProvider;
    let currentRepositoryArgument;
    let pending = false;
    let deletingBranch = false;
    let updatingPush = false;
    let updatingAutocomplete = false;

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

    const refreshAutocomplete = () => {
        const enabled = configuration.getValue('editor.inlineSuggest.enabled') !== false;
        autocompleteButton.classList.toggle('scm-toolkit-autocomplete-off', !enabled);
        autocompleteButton.setAttribute('aria-pressed', String(!enabled));
        const description = enabled
            ? 'Turn off inline autocomplete'
            : 'Turn on inline autocomplete';
        autocompleteButton.setAttribute('aria-label', description);
        autocompleteTooltip.textContent = description;
    };

    const toggleAutocomplete = async event => {
        event.stopPropagation();
        if (updatingAutocomplete) return;

        updatingAutocomplete = true;
        autocompleteButton.disabled = true;
        const enabled = configuration.getValue('editor.inlineSuggest.enabled') !== false;
        try {
            await configuration.updateValue('editor.inlineSuggest.enabled', !enabled);
        } catch (error) {
            notifications.error(error);
        } finally {
            updatingAutocomplete = false;
            autocompleteButton.disabled = false;
            refreshAutocomplete();
        }
    };

    autocompleteButton.addEventListener('click', toggleAutocomplete);
    widget.disposables.add(configuration.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('editor.inlineSuggest.enabled')) {
            refreshAutocomplete();
        }
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
            deleteButton.removeAttribute('aria-label');
            deleteTooltip.textContent = '';
        } else if (currentBranch === settings.defaultBranch) {
            const description = `${settings.defaultBranch} cannot be deleted`;
            deleteButton.setAttribute('aria-label', description);
            deleteTooltip.textContent = description;
        } else {
            const description =
                `Delete local branch ${currentBranch} if it no longer exists on ${settings.remote}`;
            deleteButton.setAttribute('aria-label', description);
            deleteTooltip.textContent = description;
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
            autocompleteButton.removeEventListener('click', toggleAutocomplete);
            branchButton.remove();
            pushControl.remove();
            deleteButton.remove();
            autocompleteButton.remove();
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
            const autocompleteWidth = autocompleteButton.hidden
                ? 0
                : autocompleteButton.getBoundingClientRect().width;
            return branchWidth + pushWidth + deleteWidth + autocompleteWidth;
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
            autocompleteButton.hidden = true;
            autocompleteButton.disabled = false;

            if (!input || input.repository.provider.providerId !== 'git') return;

            if (settings.commitAndPush) {
                pushControl.hidden = false;
                refreshPush();
            }

            if (settings.autocompleteToggle) {
                autocompleteButton.hidden = false;
                refreshAutocomplete();
            }

            deleteButton.classList.toggle(
                'scm-toolkit-has-following-control',
                !autocompleteButton.hidden
            );

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
            let blankStateRefreshDisposable;
            widget.repositoryDisposables.add(observe(reader => {
                const items = provider.statusBarCommands.read(reader) ?? [];
                // Keep the first Git status command and its original arguments so the
                // built-in branch picker remains the source of truth.
                const command = items[0];
                currentCommand = command;
                currentRepositoryArgument = command?.arguments?.[0];

                if (
                    settings.blankStateRefresh
                    && currentRepositoryArgument
                    && !blankStateRefreshDisposable
                ) {
                    blankStateRefreshDisposable = scmToolkitEnableBlankStateRefresh(
                        widget,
                        input,
                        commands,
                        currentRepositoryArgument
                    );
                    if (blankStateRefreshDisposable) {
                        widget.repositoryDisposables.add(blankStateRefreshDisposable);
                    }
                }

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
