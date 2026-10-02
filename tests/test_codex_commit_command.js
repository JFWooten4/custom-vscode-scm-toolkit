'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

async function run() {
  let command, active = false, bridgeInstalled = false, progress = 0;
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
    extensions: { getExtension: () => ({ get isActive() { return active; }, async activate() { active = true; } }) },
    commands: { registerCommand(id, callback) { command = callback; return {}; },
      async getCommands() { return bridgeInstalled ? ['scmToolkit.readCodexContext'] : []; },
      async executeCommand(id) { assert.equal(id, 'scmToolkit.readCodexContext'); return 'Same-window conversation'; } },
    ProgressLocation: { Notification: 15 },
    window: { async withProgress(options, callback) { progress++; assert.match(options.title, /local Ollama/); return callback(); } }
  };
  sandbox.module.exports.registerCodexCommitCommand(vscode, { subscriptions: [], extensionUri: { fsPath: '/extension' } });
  await assert.rejects(command({ scheme: 'file', fsPath: '/selected' }), /Close and reopen this window/);
  assert.equal(active, true, 'activate Codex before looking for its bridge');
  assert.equal(progress, 0);
  bridgeInstalled = true;
  assert.equal(await command({ scheme: 'file', fsPath: '/selected' }), 'Fix generation');
  assert.equal(progress, 1);
  console.log('Local Codex commit command checks passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
