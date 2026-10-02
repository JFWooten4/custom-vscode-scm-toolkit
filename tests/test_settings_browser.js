'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

async function run() {
  const children = [], calls = [], errors = [];
  let available = true, failOpen = false;
  const vscode = {
    Uri: { joinPath: (_, file) => ({ fsPath: `/extension/${file}` }) },
    window: { showErrorMessage: message => errors.push(message) },
    commands: {
      async getCommands() { return available ? ['workbench.action.browser.open'] : []; },
      async executeCommand(id, options) {
        calls.push({ id, options });
        if (failOpen) throw new Error('Browser failed');
      }
    }
  };
  const sandbox = vm.createContext({
    module: { exports: {} }, process, URL,
    require(name) {
      if (name === 'vscode') return vscode;
      if (name !== 'child_process') return {};
      return { spawn(executable, args, options) {
        assert.equal(executable, process.platform === 'win32' ? 'python' : 'python3');
        assert.deepEqual(Array.from(args), ['/extension/configurator.py', '--no-browser']);
        assert.equal(options.cwd, '/extension');
        assert.equal(options.stdio[1], 'pipe');
        const child = new EventEmitter();
        child.exitCode = null;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdout.setEncoding = child.stderr.setEncoding = () => {};
        child.kill = () => { child.killed = true; };
        children.push(child);
        return child;
      } };
    },
    context: { extensionUri: {}, extensionPath: '/extension' }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../workspace-search-extension/extension.js'), 'utf8'), sandbox);
  const open = () => vm.runInContext('openSettings(context)', sandbox);
  const tick = () => new Promise(resolve => setImmediate(resolve));

  available = false;
  await open();
  assert.equal(children.length, 0);
  assert.match(errors.pop(), /Update VS Code/);
  available = true;
  await open();
  await open();
  assert.equal(children.length, 1, 'Repeated clicks during startup must not start another server');
  const url = 'http://127.0.0.1:49152/?token=test';
  const line = JSON.stringify({ url });
  children[0].stdout.emit('data', '{"url":"https://example.com"}\n' + line.slice(0, 10));
  assert.equal(calls.length, 0);
  children[0].stdout.emit('data', line.slice(10) + '\n');
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'workbench.action.browser.open');
  assert.equal(calls[0].options.url, url);
  assert.equal(calls[0].options.openToSide, false);
  assert.equal(calls[0].options.reuseUrlFilter, url);
  await open();
  assert.equal(calls.length, 2, 'Repeated click must refocus the native browser');
  assert.equal(children.length, 1);
  children[0].exitCode = 0;
  children[0].emit('exit', 0);
  await open();
  assert.equal(children.length, 2, 'A finished settings session must be restartable');
  failOpen = true;
  children[1].stdout.emit('data', line + '\n');
  await tick();
  assert.equal(children[1].killed, true);
  assert.match(errors.pop(), /Integrated Browser/);
  failOpen = false;
  children[1].exitCode = 0;
  children[1].emit('exit', 0);
  await open();
  sandbox.module.exports.deactivate();
  assert.equal(children[2].killed, true, 'Closing the extension must stop its server');
  assert.equal(errors.length, 0);
  console.log('Settings native browser checks passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
