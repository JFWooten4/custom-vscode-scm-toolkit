// Runs inside VS Code's SCM input widget; services and observables are supplied by install.py.
function scmToolkitCreateControls(widget, observe, commands, notifications) {
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
    widget.element.prepend(branchButton);

    let currentCommand;
    let pending = false;

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
            branchButton.remove();
        }
    });

    return {
        width() {
            return branchButton.hidden ? 0 : branchButton.getBoundingClientRect().width;
        },

        bind(input) {
            currentCommand = undefined;
            branchButton.hidden = true;
            branchButton.disabled = true;

            if (!input || input.repository.provider.providerId !== 'git') return;

            const keepMessagePlaceholderShort = () => {
                if (input.placeholder !== 'Message') input.placeholder = 'Message';
            };
            keepMessagePlaceholderShort();
            widget.repositoryDisposables.add(input.onDidChangePlaceholder(keepMessagePlaceholderShort));

            const provider = input.repository.provider;
            widget.repositoryDisposables.add(observe(reader => {
                const items = provider.statusBarCommands.read(reader) ?? [];
                // Keep the first Git status command and its original arguments so the
                // built-in branch picker remains the source of truth.
                const command = items[0];
                currentCommand = command;

                const branch = command?.title?.replace(/\$\([^)]+\)/g, '').trim();
                branchButton.hidden = !branch;
                branchButton.disabled = pending || !command?.id;
                branchLabel.textContent = branch ?? '';
                branchButton.title = command?.tooltip || `Select branch: ${branch ?? ''}`;
                branchButton.setAttribute('aria-label', `Select branch, current branch ${branch ?? ''}`);
                widget.layout();
            }));
        }
    };
}
