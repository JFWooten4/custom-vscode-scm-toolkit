'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

async function run() {
  let command, active = false, bridgeInstalled = false, progress = 0;
  const commands = new Map();
  let additions = 0;
  const repository = {
    state: { indexChanges: ['staged'], workingTreeChanges: ['unstaged'], untrackedChanges: ['new'], mergeChanges: [] },
    async status() {},
    async add(paths) { assert.equal(paths.join(','), '.'); additions++; this.state.indexChanges = ['staged']; }
  };
  const child = {
    stdout: { setEncoding() {}, on(event, callback) { this.callback = callback; } },
    stderr: { setEncoding() {}, on() {} },
    on(event, callback) { if (event === 'close') this.close = callback; },
    stdin: { on() {}, end(value) {
      assert.equal(JSON.parse(value).context, 'Same-window conversation');
      child.stdout.callback(JSON.stringify({ message: 'Fix generation' }));
      child.close(0);
    } }
  };
  const sandbox = vm.createContext({
    module: { exports: {} }, process, setTimeout, clearTimeout,
    require: name => { assert.equal(name, 'child_process'); return { spawn(exe, args, options) {
      assert.equal(options.cwd, '/selected');
      assert.equal(args[0], '/extension/local_codex_commit.py');
      return child;
    } }; }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../workspace-search-extension/codex_commit.js'), 'utf8'), sandbox);
  const vscode = {
    Uri: { from: uri => uri, joinPath: (uri, file) => ({ fsPath: `${uri.fsPath}/${file}` }) },
    extensions: { getExtension: id => id === 'vscode.git'
      ? { async activate() { return { getAPI: () => ({ getRepository: () => repository }) }; } }
      : { get isActive() { return active; }, async activate() { active = true; } } },
    commands: { registerCommand(id, callback) { commands.set(id, callback); command = callback; return {}; },
      async getCommands() { return bridgeInstalled ? ['scmToolkit.readCodexContext'] : []; },
      async executeCommand(id) { assert.equal(id, 'scmToolkit.readCodexContext'); return 'Same-window conversation'; } },
    ProgressLocation: { Notification: 15 },
    window: { async withProgress(options, callback) { progress++; assert.match(options.title, /local Ollama/); return callback(); } }
  };
  sandbox.module.exports.registerCodexCommitCommand(vscode, { subscriptions: [], extensionUri: { fsPath: '/extension' } });
  const prepare = commands.get('scmToolkit.prepareCodexCommit');
  const uri = { scheme: 'file', fsPath: '/selected' };
  await prepare(uri);
  assert.equal(additions, 0, 'existing staged changes leave unstaged changes alone');
  repository.state.indexChanges = [];
  await prepare(uri);
  assert.equal(additions, 1, 'empty index stages the working tree including new files');
  repository.state.indexChanges = [];
  repository.state.workingTreeChanges = [];
  repository.state.untrackedChanges = [];
  await assert.rejects(prepare(uri), /no changes to commit/);
  repository.state.mergeChanges = ['conflict'];
  await assert.rejects(prepare(uri), /Resolve merge conflicts/);
  assert.equal(additions, 1, 'clean and conflicted repositories do not stage anything');
  await assert.rejects(command({ scheme: 'file', fsPath: '/selected' }), /Close and reopen this window/);
  assert.equal(active, true, 'activate Codex before looking for its bridge');
  assert.equal(progress, 0);
  bridgeInstalled = true;
  assert.equal(await command({ scheme: 'file', fsPath: '/selected' }), 'Fix generation');
  assert.equal(progress, 1);
  console.log('Local Codex commit command checks passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
