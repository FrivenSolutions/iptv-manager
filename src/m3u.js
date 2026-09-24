import readline from 'node:readline';
import { openMaybeGzip } from './fetch.js';

// key="value" pairs, tolerating single quotes and unquoted values.
export function parseAttrs(s) {
  const out = {};
  const re = /([A-Za-z0-9_-]+)=(?:"([^"]*)"|'([^']*)'|([^\s,"']+))/g;
  let m;
  while ((m = re.exec(s))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

function parseExtinf(body) {
  // The display name follows the first comma that is not inside quotes.
  let inQuote = false;
  let idx = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ',' && !inQuote) {
      idx = i;
      break;
    }
  }
  const meta = idx >= 0 ? body.slice(0, idx) : body;
  const name = idx >= 0 ? body.slice(idx + 1).trim() : '';
  const attrs = parseAttrs(meta);
  return { name: name || attrs['tvg-name'] || '', attrs, group: attrs['group-title'] || '', opts: [], url: '' };
}

// Line-at-a-time parser so large playlists never need to sit in memory as one string.
export class M3UParser {
  constructor() {
    this.header = {};
    this.entries = [];
    this.cur = null;
    this.first = true;
  }

  line(raw) {
    let line = raw.trim();
    if (this.first) {
      line = line.replace(/^﻿/, '');
      this.first = false;
    }
    if (!line) return;
    if (line.startsWith('#EXTM3U')) {
      Object.assign(this.header, parseAttrs(line.slice(7)));
    } else if (line.startsWith('#EXTINF:')) {
      this.cur = parseExtinf(line.slice(8));
    } else if (line.startsWith('#EXTGRP:')) {
      if (this.cur && !this.cur.group) this.cur.group = line.slice(8).trim();
    } else if (line.startsWith('#')) {
      // #EXTVLCOPT / #KODIPROP carry per-stream headers; keep them for direct output.
      if (this.cur && /^#(EXTVLCOPT|KODIPROP)/i.test(line)) this.cur.opts.push(line);
    } else if (this.cur) {
      this.cur.url = line;
      this.entries.push(this.cur);
      this.cur = null;
    }
  }
}

export function parseM3U(text) {
  const p = new M3UParser();
  for (const line of text.split(/\r?\n/)) p.line(line);
  return { header: p.header, entries: p.entries };
}

export async function parseM3UFile(file) {
  const p = new M3UParser();
  const input = await openMaybeGzip(file);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) p.line(line);
  return { header: p.header, entries: p.entries };
}

const VOD_EXT = /\.(mp4|mkv|avi|mov|m4v|wmv|flv|mpg|mpeg)(\?|$)/i;

export function isVod(url) {
  return /\/(movie|movies|series)\//i.test(url) || VOD_EXT.test(url);
}
