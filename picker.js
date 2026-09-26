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

async function scmToolkitPullCleanRepository(provider, commands, repositoryArgument) {
    const hasChanges = () => provider.groups.some(group => group.resources.length > 0);
    if (hasChanges()) return false;

    const historyProvider = provider.historyProvider.get();
    const localRef = historyProvider?.historyItemRef.get();
    const remoteRef = historyProvider?.historyItemRemoteRef.get();
    if (
        !historyProvider
        || !localRef?.id
        || !localRef.revision
        || !remoteRef?.id
        || !remoteRef.revision
        || localRef.revision === remoteRef.revision
    ) {
        return false;
    }

    const ancestor = await historyProvider.resolveHistoryItemRefsCommonAncestor([
        localRef.id,
        remoteRef.id
    ]);
    if (ancestor !== localRef.revision || hasChanges()) return false;

    const currentLocalRef = historyProvider.historyItemRef.get();
    const currentRemoteRef = historyProvider.historyItemRemoteRef.get();
    if (
        currentLocalRef?.revision !== localRef.revision
        || currentRemoteRef?.revision !== remoteRef.revision
        || hasChanges()
    ) {
        return false;
    }

    await commands.executeCommand('git.pull', repositoryArgument);
    return true;
}

function scmToolkitEnableBlankStateRefresh(
    widget,
    input,
    commands,
    repositoryArgument,
    autoPullClean
) {
    const doc = widget.element.ownerDocument;
    const win = doc.defaultView;
    const provider = input.repository.provider;
    if (!win || !repositoryArgument || typeof provider.onDidChangeResources !== 'function') return;

    let timer;
    let refreshing = false;
    let disposed = false;
    let lastAutoPullState;
    const progressRoot = widget.element.closest('.scm-view')?.parentElement;

    const hasChanges = () => provider.groups.some(group => group.resources.length > 0);

    const clearTimer = () => {
        if (timer === undefined) return;
        win.clearTimeout(timer);
        timer = undefined;
    };

    const maybeAutoPull = async () => {
        if (!autoPullClean || hasChanges()) return;

        const historyProvider = provider.historyProvider.get();
        const localRef = historyProvider?.historyItemRef.get();
        const remoteRef = historyProvider?.historyItemRemoteRef.get();
        if (!localRef?.revision || !remoteRef?.revision || localRef.revision === remoteRef.revision) {
            return;
        }

        const state = `${localRef.revision}:${remoteRef.revision}`;
        if (state === lastAutoPullState) return;
        lastAutoPullState = state;

        try {
            await scmToolkitPullCleanRepository(provider, commands, repositoryArgument);
        } catch {
            // Keep automatic pulls best-effort; the built-in Git extension owns Git errors.
        }
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
            progressRoot?.classList.add('scm-toolkit-refreshing');
            try {
                await commands.executeCommand('git.refresh', repositoryArgument);
                await maybeAutoPull();
            } catch {
                // The built-in Git extension owns refresh errors; keep blank-state polling best-effort.
            } finally {
                progressRoot?.classList.remove('scm-toolkit-refreshing');
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
            progressRoot?.classList.remove('scm-toolkit-refreshing');
            resourceDisposable.dispose();
            doc.removeEventListener('visibilitychange', onVisibilityChange);
        }
    };
}

const SCM_TOOLKIT_CODEX_COAUTHOR = 'Co-authored-by: Codex <noreply@openai.com>';

function scmToolkitWithCodexCoauthor(message) {
    const base = message.trimEnd();
    if (!base) return '';

    const alreadyAttributed = base.split(/\r?\n/).some(
        line => line.trim() === SCM_TOOLKIT_CODEX_COAUTHOR
    );
    return alreadyAttributed ? base : `${base}\n\n${SCM_TOOLKIT_CODEX_COAUTHOR}`;
}

function scmToolkitParseGitHubRemote(remoteUrl) {
    const value = String(remoteUrl ?? '').trim();
    if (!value) return undefined;

    const patterns = [
        /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i,
        /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
        /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i,
    ];

    for (const pattern of patterns) {
        const match = value.match(pattern);
        if (match) return { owner: match[1], repo: match[2] };
    }
    return undefined;
}

function scmToolkitPullRequestTitle(branch) {
    const tail = String(branch ?? '').split('/').filter(Boolean).pop() ?? '';
    const words = tail.replace(/[-_]+/g, ' ').trim();
    return words ? words[0].toUpperCase() + words.slice(1) : `Open ${branch}`;
}

function scmToolkitMcpError(result) {
    const message = result?.content?.find(
        item => item?.type === 'text' && typeof item.text === 'string'
    )?.text;
    return message || 'The MCP pull-request tool returned an error.';
}

async function scmToolkitWaitForMcpTool(doc, server, toolName) {
    const win = doc.defaultView;
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const tool = server.tools?.get?.().find(candidate => candidate.definition?.name === toolName);
        if (tool) return tool;
        await new Promise(resolve => win ? win.setTimeout(resolve, 100) : setTimeout(resolve, 100));
    }
    return undefined;
}

const SCM_TOOLKIT_PONY_BRANCH_NAMES = [
    // G4 canon
    'twilight-sparkle', 'rainbow-dash', 'pinkie-pie', 'rarity', 'applejack',
    'fluttershy', 'starlight-glimmer', 'trixie-lulamoon', 'sunset-shimmer',
    'princess-celestia', 'princess-luna', 'princess-cadance', 'shining-armor',
    'flurry-heart', 'apple-bloom', 'sweetie-belle', 'scootaloo', 'big-macintosh',
    'granny-smith', 'braeburn', 'sugar-belle', 'cheerilee', 'derpy-hooves',
    'doctor-hooves', 'lyra-heartstrings', 'bon-bon', 'vinyl-scratch',
    'octavia-melody', 'minuette', 'moondancer', 'lemon-hearts', 'twinkleshine',
    'coco-pommel', 'maud-pie', 'limestone-pie', 'marble-pie', 'tree-hugger',
    'coloratura', 'sassy-saddles', 'sunburst', 'tempest-shadow', 'night-glider',
    'party-favor', 'double-diamond', 'soarin', 'spitfire', 'fleetfoot',
    'lightning-dust', 'thunderlane', 'cloudchaser', 'flitter', 'vapor-trail',
    'sky-stinger', 'misty-fly', 'bulk-biceps', 'fancy-pants', 'fleur-de-lis',
    'prince-blueblood', 'diamond-tiara', 'silver-spoon', 'babs-seed', 'twist',
    'pipsqueak', 'featherweight', 'tender-taps', 'zephyr-breeze',
    'saffron-masala', 'zesty-gourmand', 'quibble-pants', 'daring-do',
    'mayor-mare', 'photo-finish', 'hoity-toity', 'sapphire-shores',
    'prim-hemline', 'filthy-rich', 'spoiled-rich', 'cheese-sandwich',
    'troubleshoes', 'burnt-oak', 'pear-butter', 'bright-mac', 'grand-pear',
    'igneous-rock-pie', 'cloudy-quartz', 'chancellor-neighsay', 'mudbriar',
    'mage-meadowbrook', 'somnambula', 'mistmane', 'rockhoof', 'flash-magnus',
    'starswirl-the-bearded', 'flash-sentry', 'suri-polomare', 'cinnamon-chai',
    'lotus-blossom', 'aloe', 'noteworthy', 'carrot-top', 'amethyst-star',
    'cloud-kicker', 'berry-punch', 'rose', 'lily-valley', 'daisy',
    'strawberry-sunrise', 'toola-roola', 'starsong',

    // Tamers12345 continuity and variants
    'flawless-sparklemoon', 'apple-bottom', 'apple-split', 'care-package',
    'jinx', 'clean-sweep', 'future-soarin', 'friendship', 'arinos',
    'dazzle-feather', 'skye-silver', 'parcelcore', 'professor-kirin',
    'bobby-moonbeam', 'professor-majorchord', 'astro-novalite',

    // Fanmade characters used by PrinceWhateverer songs
    'sweetie-bot', 'retro-city', 'felix', 'normal-oc', 'bad-oc',

    // Well-known fandom OCs and fan characters
    'apogee', 'snowdrop', 'nyx', 'fluffle-puff', 'button-mash', 'celestai',
    'turing-test', 'flower', 'cleverpony', 'gears', 'applebloom-bot',
    'scoota-bot', 'flawless',

    // Fallout: Equestria and major side-story continuities
    'littlepip', 'velvet-remedy', 'calamity', 'homage', 'steelhooves',
    'red-eye', 'xenith', 'blackjack', 'p-21', 'morning-glory', 'rampage',
    'lacunae', 'scotch-tape', 'boo', 'stygius', 'goldenblood', 'psychoshy',
    'bottlecap', 'puppysmiles', 'better-days', 'hired-gun', 'silver-storm',
    'curly-fries', 'murky-number-seven', 'brimstone-blitz', 'coral-eve',
    'glimmerlight', 'protege', 'wicked-slit', 'sundial', 'caduceus',
    'cayenne', 'silver-heart', 'harmony', 'atom-smasher', 'aurora-borealis',
    'backlash', 'brass-tacks', 'cherry-smiles', 'crossed-wires',
    'cinder-trails', 'cobalt', 'airborne', 'amber-glow', 'aqua-breeze',
    'arc-light', 'aroma', 'arsenal'
];

function scmToolkitPickPonyBranchName(refs, remote) {
    const localPrefix = 'refs/heads/';
    const remotePrefix = `refs/remotes/${remote}/`;
    const used = new Set();

    for (const ref of refs) {
        const id = String(ref?.id ?? '');
        if (id.startsWith(localPrefix)) used.add(id.slice(localPrefix.length));
        if (id.startsWith(remotePrefix)) used.add(id.slice(remotePrefix.length));
    }

    const available = SCM_TOOLKIT_PONY_BRANCH_NAMES.filter(name => !used.has(name));
    if (available.length === 0) return undefined;
    return available[Math.floor(Math.random() * available.length)];
}

function scmToolkitReleaseCommitBeforePush(repository, configuration, notifications) {
    if (
        !repository
        || typeof repository.commit !== 'function'
        || typeof repository.push !== 'function'
    ) {
        return;
    }

    const wrappedRepositories =
        globalThis.__scmToolkitAsyncPushRepositories ??= new WeakMap();
    let state = wrappedRepositories.get(repository);

    if (!state) {
        const originalCommit = repository.commit;
        const originalPush = repository.push;

        const wrappedCommit = async function(message, options) {
            const requestedPostCommitCommand = options?.postCommitCommand;
            const configuredPostCommitCommand =
                configuration.getValue('git.postCommitCommand');
            const shouldReleasePush =
                requestedPostCommitCommand === 'push'
                || (
                    requestedPostCommitCommand === undefined
                    && configuredPostCommitCommand === 'push'
                );

            if (!shouldReleasePush) {
                return originalCommit.call(repository, message, options);
            }

            await originalCommit.call(repository, message, {
                ...(options ?? {}),
                postCommitCommand: null,
            });

            void Promise.resolve()
                .then(() => originalPush.call(repository))
                .catch(error => notifications.error(error));
        };

        state = {
            references: 0,
            originalCommit,
            wrappedCommit,
        };
        repository.commit = wrappedCommit;
        wrappedRepositories.set(repository, state);
    }

    state.references += 1;
    let disposed = false;

    return {
        dispose() {
            if (disposed) return;
            disposed = true;
            state.references -= 1;
            if (state.references !== 0) return;

            if (repository.commit === state.wrappedCommit) {
                repository.commit = state.originalCommit;
            }
            wrappedRepositories.delete(repository);
        }
    };
}

function scmToolkitCreateControls(widget, observe, commands, notifications, configuration, mcpService, settings) {
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

    const syncButton = doc.createElement('button');
    syncButton.type = 'button';
    syncButton.className = 'scm-toolkit-sync-branch codicon codicon-sync';
    syncButton.hidden = true;

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

    const codexButton = doc.createElement('button');
    codexButton.type = 'button';
    codexButton.className = 'scm-toolkit-codex-coauthor codicon codicon-account';
    codexButton.hidden = true;
    codexButton.title = 'Commit with Codex co-author';
    codexButton.setAttribute('aria-label', 'Commit with Codex co-author');

    const pullRequestButton = doc.createElement('button');
    pullRequestButton.type = 'button';
    pullRequestButton.className = 'scm-toolkit-pull-request codicon codicon-git-pull-request';
    pullRequestButton.hidden = true;

    const pullRequestTooltip = doc.createElement('span');
    pullRequestTooltip.className = 'scm-toolkit-tooltip';
    pullRequestTooltip.setAttribute('aria-hidden', 'true');
    pullRequestButton.append(pullRequestTooltip);

    const ponyBranchButton = doc.createElement('button');
    ponyBranchButton.type = 'button';
    ponyBranchButton.className = 'scm-toolkit-pony-branch codicon codicon-git-branch-create';
    ponyBranchButton.hidden = true;

    const ponyBranchTooltip = doc.createElement('span');
    ponyBranchTooltip.className = 'scm-toolkit-tooltip';
    ponyBranchTooltip.setAttribute('aria-hidden', 'true');
    ponyBranchButton.append(ponyBranchTooltip);

    const settingsButton = doc.createElement('button');
    settingsButton.type = 'button';
    settingsButton.className = 'scm-toolkit-settings codicon codicon-gear';
    settingsButton.hidden = true;
    settingsButton.title = 'Open SCM Toolkit settings';
    settingsButton.setAttribute('aria-label', 'Open SCM Toolkit settings');

    widget.element.prepend(branchButton);
    widget.element.append(
        pushControl,
        syncButton,
        deleteButton,
        autocompleteButton,
        codexButton,
        pullRequestButton,
        ponyBranchButton,
        settingsButton
    );

    let currentCommand;
    let currentCommitCommand;
    let currentBranch;
    let currentHistoryProvider;
    let currentRepositoryArgument;
    let currentInput;
    let pending = false;
    let deletingBranch = false;
    let creatingPullRequest = false;
    let creatingPonyBranch = false;
    let updatingPush = false;
    let updatingAutocomplete = false;
    let committingWithCodex = false;

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

    const refreshCodexCommit = () => {
        codexButton.disabled =
            pending
            || deletingBranch
            || committingWithCodex
            || !currentInput
            || !currentCommitCommand?.id;
    };

    const commitWithCodex = async event => {
        event.stopPropagation();
        if (
            !settings.codexCoauthor
            || !currentInput
            || !currentCommitCommand?.id
            || pending
            || deletingBranch
            || committingWithCodex
        ) {
            return;
        }

        const originalMessage = currentInput.value ?? '';
        if (!originalMessage.trim()) {
            notifications.error('Enter a commit message before committing with Codex attribution.');
            return;
        }

        const attributedMessage = scmToolkitWithCodexCoauthor(originalMessage);
        committingWithCodex = true;
        refreshCodexCommit();
        currentInput.value = attributedMessage;

        try {
            await commands.executeCommand(
                currentCommitCommand.id,
                ...(currentCommitCommand.arguments ?? [])
            );
        } catch (error) {
            notifications.error(error);
        } finally {
            if (currentInput?.value === attributedMessage) {
                currentInput.value = originalMessage;
            }
            committingWithCodex = false;
            refreshCodexCommit();
        }
    };

    const refreshPullRequest = () => {
        const branch = currentBranch;
        const unavailable =
            !settings.mcpPullRequest
            || !branch
            || branch === settings.defaultBranch
            || !currentRepositoryArgument;

        pullRequestButton.hidden = !settings.mcpPullRequest;
        pullRequestButton.disabled =
            pending || deletingBranch || creatingPullRequest || creatingPonyBranch || unavailable;

        if (!branch) {
            pullRequestTooltip.textContent = 'Open a pull request for the current branch';
        } else if (branch === settings.defaultBranch) {
            pullRequestTooltip.textContent =
                `${settings.defaultBranch} is the pull-request base branch`;
        } else {
            pullRequestTooltip.textContent =
                `Open a pull request for ${branch} with ${settings.mcpPrServer}`;
        }
        pullRequestButton.setAttribute('aria-label', pullRequestTooltip.textContent);
    };

    const createPullRequest = async event => {
        event.stopPropagation();

        const branch = currentBranch;
        const repository = currentRepositoryArgument;
        if (
            !settings.mcpPullRequest
            || !branch
            || branch === settings.defaultBranch
            || !repository
            || pending
            || deletingBranch
            || creatingPullRequest
            || creatingPonyBranch
        ) {
            return;
        }

        const remote = repository.state?.remotes?.find(
            candidate => candidate.name === settings.remote
        );
        const github = scmToolkitParseGitHubRemote(remote?.pushUrl || remote?.fetchUrl);
        if (!github) {
            notifications.error(
                `Cannot create a pull request: ${settings.remote} is not a GitHub remote.`
            );
            return;
        }

        try {
            await mcpService.activateCollections();
        } catch (error) {
            notifications.error(error);
            return;
        }

        const wantedServer = String(settings.mcpPrServer).toLowerCase();
        const server = mcpService.servers.get().find(candidate => {
            const metadata = candidate.serverMetadata?.get?.();
            return [
                candidate.definition?.id,
                candidate.definition?.label,
                metadata?.serverName,
            ].some(name => String(name ?? '').toLowerCase() === wantedServer);
        });
        if (!server) {
            notifications.error(
                `MCP server "${settings.mcpPrServer}" is not configured in VS Code.`
            );
            return;
        }

        creatingPullRequest = true;
        refreshBranchControls();
        try {
            await server.start({ promptType: 'all-untrusted' });
            const tool = await scmToolkitWaitForMcpTool(doc, server, settings.mcpPrTool);
            if (!tool) {
                throw new Error(
                    `MCP tool "${settings.mcpPrTool}" was not found on ${settings.mcpPrServer}.`
                );
            }

            const result = await tool.call({
                owner: github.owner,
                repo: github.repo,
                title: scmToolkitPullRequestTitle(branch),
                prompt: `Open a pull request for branch ${branch}.`,
                body: `Opens \`${branch}\` against \`${settings.defaultBranch}\`.`,
                head: branch,
                base: settings.defaultBranch,
            });
            if (result?.isError) throw new Error(scmToolkitMcpError(result));

            const url = result?.structuredContent?.url;
            notifications.info(
                url
                    ? `Created pull request: ${url}`
                    : `Created pull request for ${branch}.`
            );
        } catch (error) {
            notifications.error(error);
        } finally {
            creatingPullRequest = false;
            refreshBranchControls();
        }
    };

    const refreshPonyBranch = () => {
        const unavailable = !settings.ponyBranch || !currentRepositoryArgument || !currentHistoryProvider;
        ponyBranchButton.hidden = !settings.ponyBranch;
        ponyBranchButton.disabled =
            pending
            || deletingBranch
            || creatingPullRequest
            || creatingPonyBranch
            || unavailable;

        const description =
            `Sync ${settings.defaultBranch} with ${settings.remote} and create a random pony branch`;
        ponyBranchButton.setAttribute('aria-label', description);
        ponyBranchTooltip.textContent = description;
    };

    const createPonyBranch = async event => {
        event.stopPropagation();

        const repository = currentRepositoryArgument;
        const historyProvider = currentHistoryProvider;
        if (
            !settings.ponyBranch
            || !repository
            || !historyProvider
            || pending
            || deletingBranch
            || creatingPullRequest
            || creatingPonyBranch
        ) {
            return;
        }

        creatingPonyBranch = true;
        pushCheckbox.disabled = true;
        refreshBranchControls();

        try {
            await commands.executeCommand('git.checkout', repository, settings.defaultBranch);
            await commands.executeCommand('git.sync', repository);

            const refs = await historyProvider.provideHistoryItemRefs([
                'refs/heads',
                `refs/remotes/${settings.remote}`,
            ]);
            const branchName = scmToolkitPickPonyBranchName(
                Array.isArray(refs) ? refs : [],
                settings.remote
            );
            if (!branchName) {
                notifications.error('All configured pony branch names are already in use.');
                return;
            }

            if (typeof repository.branch !== 'function') {
                throw new Error('The current VS Code Git repository cannot create branches directly.');
            }

            await repository.branch(branchName, true, 'HEAD');
            notifications.info(`Created and switched to ${branchName}.`);
        } catch (error) {
            notifications.error(error);
        } finally {
            creatingPonyBranch = false;
            pushCheckbox.disabled = updatingPush;
            refreshBranchControls();
        }
    };

    const refreshSyncBranch = () => {
        const branch = currentBranch;
        const repository = currentRepositoryArgument;
        syncButton.hidden = !branch;
        syncButton.disabled =
            pending
            || deletingBranch
            || creatingPullRequest
            || creatingPonyBranch
            || !repository
            || typeof repository.fetch !== 'function'
            || typeof repository.merge !== 'function'
            || branch === settings.defaultBranch;

        const description = branch === settings.defaultBranch
            ? `${settings.defaultBranch} is the sync base branch`
            : `Sync ${branch ?? 'current branch'} with ${settings.remote}/${settings.defaultBranch}`;
        syncButton.title = description;
        syncButton.setAttribute('aria-label', description);
    };

    const syncBranch = async event => {
        event.stopPropagation();

        const branch = currentBranch;
        const repository = currentRepositoryArgument;
        const input = currentInput;
        if (
            !branch
            || branch === settings.defaultBranch
            || !repository
            || !input
            || typeof repository.fetch !== 'function'
            || typeof repository.merge !== 'function'
            || pending
            || deletingBranch
            || creatingPullRequest
            || creatingPonyBranch
        ) {
            return;
        }

        pending = true;
        pushCheckbox.disabled = true;
        refreshBranchControls();

        const previousMessage = input.value ?? '';
        try {
            await repository.fetch({ remote: settings.remote });
            input.value = '🔄 Sync brach to main';
            await repository.merge(`${settings.remote}/${settings.defaultBranch}`);

            if (input.value === '🔄 Sync brach to main') {
                input.value = previousMessage;
            }
            notifications.info(`Synced ${branch} with ${settings.defaultBranch}.`);
        } catch (error) {
            // Leave merge conflicts untouched and keep the sync message for the manual commit.
            notifications.error(error);
        } finally {
            pending = false;
            pushCheckbox.disabled = updatingPush || deletingBranch;
            refreshBranchControls();
        }
    };

    const refreshBranchControls = () => {
        branchButton.disabled =
            pending || deletingBranch || creatingPullRequest || creatingPonyBranch || !currentCommand?.id;

        const unavailable =
            !settings.branchCleanup
            || !currentBranch
            || !currentHistoryProvider
            || !currentRepositoryArgument;

        deleteButton.hidden = !settings.branchCleanup || !currentBranch;
        deleteButton.disabled =
            pending
            || deletingBranch
            || creatingPullRequest
            || creatingPonyBranch
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

        refreshSyncBranch();
        refreshCodexCommit();
        refreshPullRequest();
        refreshPonyBranch();
    };

    const openBranchPicker = async event => {
        event.stopPropagation();
        const command = currentCommand;
        if (!command?.id || pending || deletingBranch || creatingPullRequest || creatingPonyBranch) return;

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
            || creatingPullRequest
            || creatingPonyBranch
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

    const openSettings = async event => {
        event.stopPropagation();
        try {
            await commands.executeCommand('scmToolkit.openSettings');
        } catch (error) {
            notifications.error(error);
        }
    };

    branchButton.addEventListener('click', openBranchPicker);
    syncButton.addEventListener('click', syncBranch);
    deleteButton.addEventListener('click', deleteBranch);
    codexButton.addEventListener('click', commitWithCodex);
    pullRequestButton.addEventListener('click', createPullRequest);
    ponyBranchButton.addEventListener('click', createPonyBranch);
    settingsButton.addEventListener('click', openSettings);
    widget.disposables.add({
        dispose() {
            branchButton.removeEventListener('click', openBranchPicker);
            syncButton.removeEventListener('click', syncBranch);
            deleteButton.removeEventListener('click', deleteBranch);
            pushCheckbox.removeEventListener('change', changePush);
            autocompleteButton.removeEventListener('click', toggleAutocomplete);
            codexButton.removeEventListener('click', commitWithCodex);
            pullRequestButton.removeEventListener('click', createPullRequest);
            ponyBranchButton.removeEventListener('click', createPonyBranch);
            settingsButton.removeEventListener('click', openSettings);
            branchButton.remove();
            pushControl.remove();
            syncButton.remove();
            deleteButton.remove();
            autocompleteButton.remove();
            codexButton.remove();
            pullRequestButton.remove();
            ponyBranchButton.remove();
            settingsButton.remove();
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
            const syncWidth = syncButton.hidden
                ? 0
                : syncButton.getBoundingClientRect().width;
            const deleteWidth = deleteButton.hidden
                ? 0
                : deleteButton.getBoundingClientRect().width;
            const autocompleteWidth = autocompleteButton.hidden
                ? 0
                : autocompleteButton.getBoundingClientRect().width;
            const codexWidth = codexButton.hidden
                ? 0
                : codexButton.getBoundingClientRect().width;
            const pullRequestWidth = pullRequestButton.hidden
                ? 0
                : pullRequestButton.getBoundingClientRect().width;
            const ponyBranchWidth = ponyBranchButton.hidden
                ? 0
                : ponyBranchButton.getBoundingClientRect().width;
            const settingsWidth = settingsButton.hidden
                ? 0
                : settingsButton.getBoundingClientRect().width;
            return branchWidth + pushWidth + syncWidth + deleteWidth + autocompleteWidth
                + codexWidth + pullRequestWidth + ponyBranchWidth + settingsWidth;
        },

        bind(input) {
            currentCommand = undefined;
            currentCommitCommand = undefined;
            currentBranch = undefined;
            currentHistoryProvider = undefined;
            currentRepositoryArgument = undefined;
            currentInput = undefined;
            branchButton.hidden = true;
            branchButton.disabled = true;
            pushControl.hidden = true;
            syncButton.hidden = true;
            syncButton.disabled = true;
            deleteButton.hidden = true;
            deleteButton.disabled = true;
            autocompleteButton.hidden = true;
            autocompleteButton.disabled = false;
            codexButton.hidden = true;
            codexButton.disabled = true;
            pullRequestButton.hidden = true;
            pullRequestButton.disabled = true;
            ponyBranchButton.hidden = true;
            ponyBranchButton.disabled = true;
            settingsButton.hidden = true;

            if (!input || input.repository.provider.providerId !== 'git') return;
            currentInput = input;
            settingsButton.hidden = false;
            const provider = input.repository.provider;
            currentCommitCommand = provider.acceptInputCommand;

            if (settings.commitAndPush) {
                pushControl.hidden = false;
                refreshPush();
            }

            if (settings.autocompleteToggle) {
                autocompleteButton.hidden = false;
                refreshAutocomplete();
            }

            if (settings.codexCoauthor) {
                codexButton.hidden = false;
                refreshCodexCommit();
            }

            if (settings.mcpPullRequest) {
                pullRequestButton.hidden = false;
                refreshPullRequest();
            }

            if (settings.ponyBranch) {
                ponyBranchButton.hidden = false;
                refreshPonyBranch();
            }

            syncButton.classList.toggle(
                'scm-toolkit-has-following-control',
                !deleteButton.hidden || !autocompleteButton.hidden || !codexButton.hidden
                    || !pullRequestButton.hidden || !ponyBranchButton.hidden || !settingsButton.hidden
            );
            deleteButton.classList.toggle(
                'scm-toolkit-has-following-control',
                !autocompleteButton.hidden || !codexButton.hidden || !pullRequestButton.hidden
                    || !ponyBranchButton.hidden || !settingsButton.hidden
            );
            autocompleteButton.classList.toggle(
                'scm-toolkit-has-following-control',
                !codexButton.hidden || !pullRequestButton.hidden || !ponyBranchButton.hidden
                    || !settingsButton.hidden
            );
            codexButton.classList.toggle(
                'scm-toolkit-has-following-control',
                !pullRequestButton.hidden || !ponyBranchButton.hidden || !settingsButton.hidden
            );
            pullRequestButton.classList.toggle(
                'scm-toolkit-has-following-control',
                !ponyBranchButton.hidden || !settingsButton.hidden
            );
            ponyBranchButton.classList.toggle(
                'scm-toolkit-has-following-control',
                !settingsButton.hidden
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

            let blankStateRefreshDisposable;
            widget.repositoryDisposables.add(observe(reader => {
                const items = provider.statusBarCommands.read(reader) ?? [];
                // Keep the first Git status command and its original arguments so the
                // built-in branch picker remains the source of truth.
                const command = items[0];
                currentCommand = command;
                currentRepositoryArgument = command?.arguments?.[0];

                if (
                    settings.commitAndPush
                    && currentRepositoryArgument
                    && !widget.repositoryDisposables.__scmToolkitAsyncPushBound
                ) {
                    const asyncPushDisposable = scmToolkitReleaseCommitBeforePush(
                        currentRepositoryArgument,
                        configuration,
                        notifications
                    );
                    if (asyncPushDisposable) {
                        widget.repositoryDisposables.__scmToolkitAsyncPushBound = true;
                        widget.repositoryDisposables.add(asyncPushDisposable);
                    }
                }

                if (
                    settings.blankStateRefresh
                    && currentRepositoryArgument
                    && !blankStateRefreshDisposable
                ) {
                    blankStateRefreshDisposable = scmToolkitEnableBlankStateRefresh(
                        widget,
                        input,
                        commands,
                        currentRepositoryArgument,
                        settings.autoPullClean
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
