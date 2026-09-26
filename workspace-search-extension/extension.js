'use strict';

const vscode = require('vscode');
const { SearchIndex } = require('./search_index');
const { WorkspaceSearchViewProvider } = require('./view');

const VIEW_ID = 'scmToolkit.workspaceSearch';
const CONFIG_ROOT = 'scmToolkit.workspaceSearch';

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
