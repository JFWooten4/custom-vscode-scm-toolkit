'use strict';

const assert = require('assert');
const { keywordScore, chunkText, normalizeVector, cosine } = require('../workspace-search-extension/core');
const { normalizeBaseUrl } = require('../workspace-search-extension/ollama');

assert(keywordScore('DTC federal reserve', 'DTC applied for Federal Reserve membership') > 0.7);
assert(chunkText('alpha '.repeat(600)).length > 1);
const unit = normalizeVector([3, 4]);
assert(Math.abs(cosine(unit, unit) - 1) < 1e-9);
assert.strictEqual(normalizeBaseUrl('http://127.0.0.1:11434').hostname, '127.0.0.1');
assert.throws(() => normalizeBaseUrl('https://example.com'), /local Ollama/);
console.log('Workspace Search core checks passed.');
