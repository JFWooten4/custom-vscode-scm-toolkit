'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const { chunkText, keywordScore, cosine } = require('./core');
const { extractText } = require('./extract');
const { embedTexts } = require('./ollama');

const INDEX_VERSION = 1;

function workspaceKey() {
  const folders = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.toString()).sort().join('\n');
  return crypto.createHash('sha1').update(folders).digest('hex');
}

class SearchIndex {
  constructor(context, getSettings) {
    this.context = context;
    this.getSettings = getSettings;
    this.files = new Map();
    this.dirty = new Set();
    this.loaded = false;
    this.embeddingWarning = '';
    this.embeddingAvailable = true;
    this.persistTimer = undefined;
  }

  get storageUri() {
    return vscode.Uri.joinPath(this.context.globalStorageUri, `workspace-search-${workspaceKey()}.json`);
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await vscode.workspace.fs.readFile(this.storageUri);
      const payload = JSON.parse(Buffer.from(raw).toString('utf8'));
      if (payload.version !== INDEX_VERSION || !Array.isArray(payload.files)) return;
      for (const file of payload.files) this.files.set(file.uri, file);
    } catch {
      // A missing or stale index starts clean.
    }
  }

  async persist() {
    if (!this.loaded) return;
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    const payload = JSON.stringify({ version: INDEX_VERSION, files: [...this.files.values()] });
    const temp = vscode.Uri.joinPath(this.context.globalStorageUri, `workspace-search-${workspaceKey()}.tmp`);
    await vscode.workspace.fs.writeFile(temp, Buffer.from(payload));
    try { await vscode.workspace.fs.delete(this.storageUri, { useTrash: false }); } catch {}
    await vscode.workspace.fs.rename(temp, this.storageUri, { overwrite: true });
  }

  schedulePersist() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persist().catch(() => {});
    }, 750);
  }

  markDirty(uri) { this.dirty.add(uri.toString()); }

  remove(uri) {
    this.dirty.delete(uri.toString());
    this.files.delete(uri.toString());
    this.schedulePersist();
  }

  async clear() {
    this.files.clear();
    this.dirty.clear();
    try { await vscode.workspace.fs.delete(this.storageUri, { useTrash: false }); } catch {}
  }

  async indexUri(uri, stat) {
    const settings = this.getSettings();
    const text = await extractText(uri, stat.size, settings.maxFileSizeMB);
    if (!text.trim()) {
      this.files.delete(uri.toString());
      return;
    }
    const chunks = chunkText(text);
    const indexed = chunks.map(chunk => ({ ...chunk, vector: null }));
    if (this.embeddingAvailable) {
      try {
        for (let offset = 0; offset < chunks.length; offset += 16) {
          const batch = chunks.slice(offset, offset + 16).map(chunk => chunk.text);
          const vectors = await embedTexts(settings, batch);
          for (let i = 0; i < vectors.length; i += 1) indexed[offset + i].vector = vectors[i];
        }
        this.embeddingWarning = '';
      } catch (error) {
        this.embeddingAvailable = false;
        this.embeddingWarning = `Semantic indexing unavailable: ${error.message}`;
      }
    }
    this.files.set(uri.toString(), { uri: uri.toString(), mtime: stat.mtime, size: stat.size, chunks: indexed });
  }

  async refresh({ force = false, progress } = {}) {
    await this.load();
    if (force) {
      this.embeddingAvailable = true;
      this.embeddingWarning = '';
    }
    const settings = this.getSettings();
    const uris = await vscode.workspace.findFiles('**/*', settings.exclude || undefined, settings.maxFiles);
    const seen = new Set();
    let processed = 0;
    for (const uri of uris) {
      const key = uri.toString();
      seen.add(key);
      let stat;
      try { stat = await vscode.workspace.fs.stat(uri); } catch { continue; }
      if ((stat.type & vscode.FileType.File) === 0) continue;
      const previous = this.files.get(key);
      const changed = force || this.dirty.has(key) || !previous || previous.mtime !== stat.mtime || previous.size !== stat.size;
      if (!changed) continue;
      progress?.report({ message: vscode.workspace.asRelativePath(uri, false) });
      await this.indexUri(uri, stat);
      this.dirty.delete(key);
      processed += 1;
    }
    for (const key of [...this.files.keys()]) if (!seen.has(key)) this.files.delete(key);
    if (processed || force) await this.persist();
    return { files: this.files.size, processed, warning: this.embeddingWarning };
  }

  async search(query, mode) {
    await this.load();
    if (!this.files.size || this.dirty.size) await this.refresh();
    const settings = this.getSettings();
    const selectedMode = mode || settings.mode;
    let queryVector = null;
    if (selectedMode !== 'exact') {
      try {
        [queryVector] = await embedTexts(settings, [query]);
        this.embeddingAvailable = true;
      } catch (error) {
        this.embeddingWarning = `Semantic search unavailable: ${error.message}`;
      }
    }
    const scored = [];
    for (const file of this.files.values()) {
      const uri = vscode.Uri.parse(file.uri);
      const relative = vscode.workspace.asRelativePath(uri, false);
      for (const chunk of file.chunks || []) {
        const exact = keywordScore(query, `${relative}\n${chunk.text}`);
        const semantic = queryVector && chunk.vector ? Math.max(0, cosine(queryVector, chunk.vector)) : 0;
        const score = selectedMode === 'exact'
            ? exact
            : selectedMode === 'semantic'
                ? semantic
                : (!queryVector || !chunk.vector)
                    ? exact
                    : semantic * 0.78 + exact * 0.22;
        if (score > 0) scored.push({ uri: file.uri, relative, line: chunk.line, text: chunk.text, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return { results: scored.slice(0, settings.resultLimit), warning: this.embeddingWarning, mode: selectedMode };
  }
}

module.exports = { SearchIndex };
