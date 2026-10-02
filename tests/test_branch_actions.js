'use strict';

const assert = require('node:assert/strict');
const { createBranch, deleteBranch, registerBranchCommands } = require('../workspace-search-extension/branch_actions');

const options = { defaultBranch: 'main', remote: 'origin', names: ['used', 'remote-used', 'fresh'] };

function fixture() {
  const calls = [];
  const repository = {
    state: { HEAD: { name: 'topic' } },
    async status() { calls.push(['status']); },
    async checkout(name) {
      calls.push(['checkout', name]);
      this.state.HEAD = { name, upstream: { remote: 'origin', name: 'main' }, ahead: 0 };
    },
    async pull() { calls.push(['pull']); },
    async push(...args) { calls.push(['push', ...args]); },
    async fetch(opts) { calls.push(['fetch', opts]); },
    async getRefs(opts) {
      calls.push(['refs', opts]);
      return [{ name: 'used' }, { name: 'origin/remote-used' }, { name: 'origin/main' }];
    },
    async createBranch(...args) { calls.push(['create', ...args]); },
    async deleteBranch(...args) { calls.push(['delete', ...args]); }
  };
  return { repository, calls };
}

async function run() {
  {
    const { repository, calls } = fixture();
    assert.equal(await createBranch(repository, options, () => 0), 'fresh');
    assert.deepEqual(calls.at(-1), ['create', 'fresh', true, 'HEAD']);
    assert(calls.findIndex(call => call[0] === 'pull') < calls.findIndex(call => call[0] === 'refs'));
    assert(!calls.some(call => call[0] === 'push'));
  }
  for (const method of ['checkout', 'pull', 'push']) {
    const { repository, calls } = fixture();
    if (method === 'push') repository.pull = async () => { repository.state.HEAD.ahead = 1; };
    repository[method] = async () => { throw new Error(`${method} failed`); };
    await assert.rejects(createBranch(repository, options), new RegExp(`${method} failed`));
    assert(!calls.some(call => call[0] === 'create'));
  }
  {
    const { repository, calls } = fixture();
    repository.checkout = async () => {}; // A cancelled checkout must not continue.
    await assert.rejects(createBranch(repository, options), /Could not switch/);
    assert(!calls.some(call => call[0] === 'create' || call[0] === 'pull'));
  }
  {
    const { repository, calls } = fixture();
    repository.checkout = async name => { repository.state.HEAD = { name }; };
    await assert.rejects(createBranch(repository, options), /must track/);
    assert(!calls.some(call => call[0] === 'create' || call[0] === 'pull'));
  }
  {
    const { repository } = fixture();
    await assert.rejects(createBranch(repository, { ...options, names: ['used', 'remote-used'] }), /already in use/);
  }
  {
    const { repository, calls } = fixture();
    await deleteBranch(repository, { ...options, branch: 'topic' });
    assert.deepEqual(calls[1], ['fetch', { remote: 'origin', prune: true }]);
    assert.deepEqual(calls.at(-1), ['delete', 'topic', false]);
    assert(calls.findIndex(call => call[0] === 'pull') < calls.findIndex(call => call[0] === 'delete'));
  }
  for (const refs of [[], [{ name: 'origin/topic' }]]) {
    const { repository, calls } = fixture();
    repository.getRefs = async () => refs;
    await assert.rejects(deleteBranch(repository, { ...options, branch: 'topic' }), /could not be verified|still exists/);
    assert(!calls.some(call => call[0] === 'checkout' || call[0] === 'delete'));
  }
  for (const branch of ['main', 'different']) {
    const { repository, calls } = fixture();
    await assert.rejects(deleteBranch(repository, { ...options, branch }), /Cannot delete|active branch changed/);
    assert(!calls.some(call => call[0] === 'fetch' || call[0] === 'delete'));
  }
  for (const method of ['fetch', 'pull', 'deleteBranch']) {
    const { repository } = fixture();
    repository[method] = async () => { throw new Error(`${method} failed`); };
    await assert.rejects(deleteBranch(repository, { ...options, branch: 'topic' }), new RegExp(`${method} failed`));
  }
  {
    const { repository, calls } = fixture();
    repository.pull = async () => { repository.state.HEAD.ahead = 2; };
    await createBranch(repository, options, () => 0);
    assert.deepEqual(calls.find(call => call[0] === 'push'), ['push', 'origin', 'main:main']);
  }
  {
    const { repository } = fixture();
    const commands = new Map();
    const uri = { scheme: 'file', path: '/selected-repository' };
    const vscode = {
      Uri: { from(components) {
        assert.equal(components.scheme, uri.scheme);
        assert.equal(components.path, uri.path);
        return uri;
      } },
      commands: { registerCommand(id, callback) { commands.set(id, callback); return { dispose() {} }; } },
      extensions: { getExtension(id) {
        assert.equal(id, 'vscode.git');
        return { async activate() { return { getAPI(version) {
          assert.equal(version, 1);
          return { getRepository(selected) { assert.equal(selected, uri); return repository; } };
        } }; } };
      } }
    };
    const context = { subscriptions: [] };
    registerBranchCommands(vscode, context);
    assert.equal(context.subscriptions.length, 2);
    assert.equal(await commands.get('scmToolkit.createBranch')(uri, options), 'fresh');
    assert.equal(await commands.get('scmToolkit.createBranch')({ ...uri }, options), 'fresh');
    assert.equal(await commands.get('scmToolkit.createBranch')({ rootUri: uri }, options), 'fresh');
    repository.state.HEAD = { name: 'topic' };
    assert.equal(await commands.get('scmToolkit.deleteBranch')({ rootUri: uri }, {
      ...options, branch: 'topic'
    }), 'topic');
  }
  console.log('Branch action regression checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
