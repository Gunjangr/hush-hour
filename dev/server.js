#!/usr/bin/env node
/*
 * Local test server - no npm install needed.
 *   node dev/server.js --key ../hush-hour-PRIVATE/Key.gs [--port 8080] [--db dev/.data/sheet.json]
 *
 * Serves the site and runs the real apps-script/Code.gs against an in-memory fake of
 * Google Sheets (persisted to a JSON file), so the whole flow can be tried before deploying.
 * The pages call /api automatically when opened on localhost.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : def;
};
const PORT = Number(arg('port', process.env.PORT || 8080));
const KEY_GS = path.resolve(arg('key', path.join(ROOT, '..', 'hush-hour-PRIVATE', 'Key.gs')));
const DB = path.resolve(arg('db', path.join(__dirname, '.data', 'sheet.json')));
const ADMIN_KEY = arg('admin-key', 'local-admin');

if (!fs.existsSync(KEY_GS)) {
  console.error('Key.gs not found at ' + KEY_GS + '\nRun tools/build_dataset.py first, or pass --key <path>.');
  process.exit(1);
}

/* ---------------------------------------------------------------- fake Apps Script */

function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch (e) { return { sheets: {}, props: {} }; }
}
const db = loadDb();
function saveDb() {
  fs.mkdirSync(path.dirname(DB), { recursive: true });
  fs.writeFileSync(DB, JSON.stringify(db, (k, v) => v, 1));
}

function makeSheet(name) {
  const rows = () => db.sheets[name];
  const width = () => rows().reduce((m, r) => Math.max(m, r.length), 0);
  const cell = v => (v === undefined || v === null ? '' : v);
  function range(row, col, nr = 1, nc = 1) {
    return {
      getValues() {
        const out = [];
        for (let r = 0; r < nr; r++) {
          const src = rows()[row - 1 + r] || [];
          const line = [];
          for (let c = 0; c < nc; c++) line.push(cell(src[col - 1 + c]));
          out.push(line);
        }
        return out;
      },
      setValues(values) {
        if (values.length !== nr || values.some(v => v.length !== nc)) throw new Error('setValues: size mismatch');
        for (let r = 0; r < nr; r++) {
          const idx = row - 1 + r;
          while (rows().length <= idx) rows().push([]);
          for (let c = 0; c < nc; c++) rows()[idx][col - 1 + c] = values[r][c];
        }
        return this;
      },
      setValue(v) { return this.setValues([[v]]); }
    };
  }
  return {
    getName: () => name,
    getLastRow: () => {
      for (let i = rows().length - 1; i >= 0; i--) if (rows()[i].some(v => v !== '' && v !== undefined && v !== null)) return i + 1;
      return 0;
    },
    getRange: range,
    getDataRange() { return range(1, 1, Math.max(this.getLastRow(), 1), Math.max(width(), 1)); },
    appendRow(values) { rows().splice(this.getLastRow(), 0, values.slice()); return this; },
    clearContents() { db.sheets[name] = []; return this; },
    setFrozenRows() { return this; }
  };
}

const spreadsheet = {
  getSheetByName: n => (db.sheets[n] ? makeSheet(n) : null),
  insertSheet: n => { db.sheets[n] = db.sheets[n] || []; return makeSheet(n); }
};

const gas = {
  SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, getUi: () => { throw new Error('no UI in dev'); } },
  LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
  ContentService: {
    MimeType: { JSON: 'application/json' },
    createTextOutput: s => ({ content: s, setMimeType() { return this; }, getContent() { return this.content; } })
  },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: k => (k in db.props ? db.props[k] : null),
      setProperty: (k, v) => { db.props[k] = String(v); }
    })
  },
  Utilities: { getUuid: () => crypto.randomUUID() },
  console
};

const ctx = vm.createContext(gas);
vm.runInContext(fs.readFileSync(KEY_GS, 'utf8'), ctx, { filename: 'Key.gs' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });
if (!db.props.ADMIN_KEY) db.props.ADMIN_KEY = ADMIN_KEY;
ctx.setup();
saveDb();

/* ---------------------------------------------------------------- http */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wav': 'audio/wav', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8'
};

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) || rel.includes('/.') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  const size = fs.statSync(file).size;
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const start = m[1] ? Number(m[1]) : size - Number(m[2]);
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`, 'Cache-Control': 'no-cache' });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size, 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

function api(req, res) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (req.method === 'GET') {
    const parameter = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
    res.writeHead(200, cors);
    return res.end(ctx.doGet({ parameter }).getContent());
  }
  let body = '';
  req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
  req.on('end', () => {
    const out = ctx.doPost({ postData: { contents: body, type: 'text/plain' }, parameter: {} }).getContent();
    saveDb();
    res.writeHead(200, cors);
    res.end(out);
  });
}

http.createServer((req, res) => {
  if (new URL(req.url, 'http://x').pathname === '/api') return api(req, res);
  serveStatic(req, res);
}).listen(PORT, () => {
  console.log(`Hush Hour dev server: http://localhost:${PORT}/`);
  console.log(`Admin page:           http://localhost:${PORT}/admin.html   (admin key: ${db.props.ADMIN_KEY})`);
  console.log(`Fake sheet:           ${DB}`);
});
