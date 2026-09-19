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
    widget.element.prepend(branchButton);
    widget.element.append(pushControl);

    let currentCommand;
    let pending = false;
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
            pushCheckbox.disabled = false;
            refreshPush();
        }
    };

    pushCheckbox.addEventListener('change', changePush);
    widget.disposables.add(configuration.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('git.postCommitCommand')) refreshPush();
    }));

    const openBranchPicker = async event => {
        event.stopPropagation();
        const command = currentCommand;
        if (!command?.id || pending) return;

        pending = true;
        branchButton.disabled = true;
        try {
            await commands.executeCommand(command.id, ...(command.arguments ?? []));
        } catch (error) {
            notifications.error(error);
        } finally {
            pending = false;
            branchButton.disabled = !currentCommand?.id;
        }
    };

    branchButton.addEventListener('click', openBranchPicker);
    widget.disposables.add({
        dispose() {
            branchButton.removeEventListener('click', openBranchPicker);
            pushCheckbox.removeEventListener('change', changePush);
            branchButton.remove();
            pushControl.remove();
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
            return branchWidth + pushWidth;
        },

        bind(input) {
            currentCommand = undefined;
            branchButton.hidden = true;
            branchButton.disabled = true;
            pushControl.hidden = true;

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

                const branch = command?.title?.replace(/\$\([^)]+\)/g, '').trim();
                branchButton.hidden = !settings.branchPicker || !branch;
                branchButton.disabled = pending || !command?.id;
                branchLabel.textContent = branch ?? '';
                branchButton.title = command?.tooltip || `Select branch: ${branch ?? ''}`;
                branchButton.setAttribute('aria-label', `Select branch, current branch ${branch ?? ''}`);
                widget.layout();
            }));
        }
    };
}
