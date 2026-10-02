'use strict';

function tokenize(value) {
  return String(value || '').toLowerCase().match(/[a-z0-9_$.-]{2,}/g) || [];
}

function keywordScore(query, text) {
  const q = String(query || '').trim().toLowerCase();
  const haystack = String(text || '').toLowerCase();
  if (!q || !haystack) return 0;
  const tokens = [...new Set(tokenize(q))];
  if (!tokens.length) return haystack.includes(q) ? 1 : 0;
  let matched = 0;
  for (const token of tokens) if (haystack.includes(token)) matched += 1;
  const coverage = matched / tokens.length;
  return Math.min(1, coverage * 0.75 + (haystack.includes(q) ? 0.35 : 0));
}

function normalizeVector(vector) {
  if (!Array.isArray(vector) || !vector.length) return null;
  let sum = 0;
  for (const value of vector) sum += value * value;
  const magnitude = Math.sqrt(sum);
  if (!magnitude) return null;
  return vector.map(value => value / magnitude);
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

function lineAtOffset(text, offset) {
  let line = 0;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function chunkText(text) {
  const clean = String(text || '').replace(/\r\n/g, '\n');
  if (!clean.trim()) return [];
  const target = 1400;
  const overlap = 180;
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + target);
    if (end < clean.length) {
      const boundary = Math.max(clean.lastIndexOf('\n', end), clean.lastIndexOf(' ', end));
      if (boundary > start + 700) end = boundary;
    }
    const raw = clean.slice(start, end).trim();
    if (raw) chunks.push({ text: raw, line: lineAtOffset(clean, start) });
    if (end >= clean.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

module.exports = { tokenize, keywordScore, normalizeVector, cosine, chunkText };
