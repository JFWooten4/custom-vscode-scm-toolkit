'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../picker.js'), 'utf8');
function callback(name) {
  const match = source.match(new RegExp(`    const ${name} = ([\\s\\S]*?)\\n    };`));
  assert(match, `${name} callback exists`);
  return `const ${name} = ${match[1]}\n    };`;
}

async function run() {
  const provider = {};
  const input = { repository: { provider }, value: 'Fix button' };
  const calls = [];
  const errors = [];
  const context = vm.createContext({
    currentInput: input,
    pending: false,
    deletingBranch: false,
    committingWithCodex: false,
    codexButton: {},
    settings: { codexCoauthor: true },
    scmToolkitWithCodexCoauthor: message => `${message}\n\nCo-authored-by: Codex <noreply@openai.com>`,
    notifications: { error: error => errors.push(error) },
    commands: { async executeCommand(id, ...args) { calls.push({ id, args, message: input.value }); } }
  });
  vm.runInContext(`${callback('refreshCodexCommit')}\n${callback('commitWithCodex')}\nthis.refresh = refreshCodexCommit; this.commit = commitWithCodex;`, context);
  context.refresh();
  assert.equal(context.codexButton.disabled, true);
  provider.acceptInputCommand = { id: 'provider.commit', arguments: ['selected-repository'] };
  context.refresh();
  assert.equal(context.codexButton.disabled, false, 'Git registration after bind enables the button');
  provider.acceptInputCommand = { id: 'provider.updatedCommit', arguments: ['updated-repository'] };
  await context.commit({ stopPropagation() {} });
  assert.equal(calls[0].id, 'provider.updatedCommit', 'click uses the latest provider command');
  assert.deepEqual(calls[0].args, ['updated-repository']);
  assert.match(calls[0].message, /Co-authored-by: Codex <noreply@openai.com>/);
  assert.equal(input.value, 'Fix button');
  assert.equal(context.codexButton.disabled, false);
  assert.deepEqual(errors, []);
  console.log('Codex commit startup regression checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
