'use strict';

const vscode = require('vscode');
const { spawn } = require('child_process');
const { SearchIndex } = require('./search_index');
const { WorkspaceSearchViewProvider } = require('./view');

const VIEW_ID = 'scmToolkit.workspaceSearch';
const CONFIG_ROOT = 'scmToolkit.workspaceSearch';
let configuratorProcess;

function openSettings(context) {
  if (configuratorProcess && configuratorProcess.exitCode === null) {
    vscode.window.showInformationMessage('SCM Toolkit settings are already open.');
    return;
  }

  const script = vscode.Uri.joinPath(context.extensionUri, 'configurator.py').fsPath;
  const python = process.platform === 'win32' ? 'python' : 'python3';
  let stderr = '';
  const child = spawn(python, [script], {
    cwd: context.extensionPath,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  configuratorProcess = child;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => {
    configuratorProcess = undefined;
    vscode.window.showErrorMessage(`Unable to open SCM Toolkit settings: ${error.message}`);
  });
  child.on('exit', code => {
    configuratorProcess = undefined;
    if (code && code !== 0) {
      vscode.window.showErrorMessage(
        `SCM Toolkit settings exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : '.'}`
      );
    }
  });
}

async function linkedGithubRepositories(query = '') {
  const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
  const needle = String(query || '').trim().toLowerCase();
  const repositories = [];

  for (let page = 1; page <= 20; page += 1) {
    const response = await fetch(
      `https://api.github.com/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=updated&per_page=100&page=${page}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${session.accessToken}`,
          'X-GitHub-Api-Version': '2022-11-28'
        }
      }
    );
    if (!response.ok) {
      throw new Error(`GitHub repository search failed (${response.status}).`);
    }
    const pageItems = await response.json();
    if (!Array.isArray(pageItems)) break;
    for (const repo of pageItems) {
      const fullName = String(repo.full_name || '');
      if (!fullName || (needle && !fullName.toLowerCase().includes(needle))) continue;
      repositories.push({
        fullName,
        private: Boolean(repo.private),
        htmlUrl: String(repo.html_url || ''),
        permissions: repo.permissions || {}
      });
    }
    if (pageItems.length < 100) break;
  }

  return repositories;
}

async function searchLinkedGithubRepositories(query) {
  const supplied = typeof query === 'string';
  const search = supplied
    ? query
    : await vscode.window.showInputBox({
        prompt: 'Search repositories available through the linked GitHub account',
        placeHolder: 'owner/repository'
      });
  if (search === undefined) return [];
  const repositories = await linkedGithubRepositories(search);
  if (supplied) return repositories;

  if (!repositories.length) {
    vscode.window.showInformationMessage('No accessible GitHub repositories matched that search.');
    return [];
  }

  const pick = await vscode.window.showQuickPick(
    repositories.map(repo => ({
      label: repo.fullName,
      description: repo.private ? 'private' : 'public',
      repo
    })),
    { placeHolder: 'Repositories use the same linked GitHub authorization boundary.' }
  );
  if (pick?.repo?.htmlUrl) {
    await vscode.env.openExternal(vscode.Uri.parse(pick.repo.htmlUrl));
  }
  return repositories;
}

function settings() {
  const cfg = vscode.workspace.getConfiguration(CONFIG_ROOT);
  return {
    embeddingModel: cfg.get('embeddingModel', 'qwen3-embedding:0.6b'),
    chatModel: cfg.get('chatModel', '').trim(),
    ollamaUrl: cfg.get('ollamaUrl', 'http://127.0.0.1:11434'),
    mode: cfg.get('mode', 'hybrid'),
    resultLimit: cfg.get('resultLimit', 20),
    maxFiles: cfg.get('maxFiles', 5000),
    maxFileSizeMB: cfg.get('maxFileSizeMB', 10),
    exclude: cfg.get('exclude', '**/{.git,node_modules,dist,build,out,target,.venv,venv,__pycache__,coverage}/**')
  };
}

async function activate(context) {
  const index = new SearchIndex(context, settings);
  const provider = new WorkspaceSearchViewProvider(index, settings);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } })
  );
  context.subscriptions.push(vscode.commands.registerCommand('scmToolkit.openSettings', () => {
    openSettings(context);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('scmToolkit.chatgpt.searchRepositories', query => {
    return searchLinkedGithubRepositories(query);
  }));

  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(uri => index.markDirty(uri)),
    watcher.onDidChange(uri => index.markDirty(uri)),
    watcher.onDidDelete(uri => index.remove(uri))
  );

  context.subscriptions.push(vscode.commands.registerCommand('scmToolkit.workspaceSearch.reindex', async () => {
    try {
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Rebuilding workspace search index',
        cancellable: false
      }, progress => index.refresh({ force: true, progress }));
      provider.post({ type: 'results', query: provider.lastQuery, results: [], warning: result.warning, mode: settings().mode });
      vscode.window.showInformationMessage(`Workspace Search indexed ${result.files} files.`);
    } catch (error) {
      vscode.window.showErrorMessage(`Workspace Search: ${error.message}`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('scmToolkit.workspaceSearch.clearIndex', async () => {
    await index.clear();
    provider.lastResults = [];
    provider.post({ type: 'results', results: [], warning: '', mode: settings().mode });
    vscode.window.showInformationMessage('Workspace Search index cleared.');
  }));
}

function deactivate() {}

module.exports = { activate, deactivate };
