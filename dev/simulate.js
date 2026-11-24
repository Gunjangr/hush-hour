#!/usr/bin/env node
/*
 * End-to-end check of the backend rules against the local dev server.
 *   node dev/simulate.js [--url http://localhost:8080/api] [--raters 6] [--admin-key local-admin]
 * Use a fresh dev database (delete dev/.data) - it fills the fake sheet with test raters.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const URL_ = arg('url', 'http://localhost:8080/api');
const N = Number(arg('raters', 6));
const ADMIN = arg('admin-key', 'local-admin');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'vectors.json'), 'utf8'));
const vec = Object.fromEntries(manifest.vectors.map(v => [v.id, v]));

let failures = 0;
function check(cond, msg) { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failures++; }
async function call(action, payload = {}) {
  const r = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action, ...payload }) });
  return r.json();
}
const ratingsFor = (assigned, score) => assigned.flatMap(id => vec[id].samples.map((sid, i) => ({
  sampleId: sid, position: i + 1, voiceQuality: score(sid, 'vq'), noiseSuppression: score(sid, 'ns'), intelligibility: score(sid, 'it') })));

(async () => {
  console.log('status');
  let st = await call('status');
  check(st.ok && st.data.icons.length >= 15, `status lists ${st.data.icons.length} avatars`);
  const per = st.data.perRater;

  console.log('validation');
  check((await call('join', { name: '', icon: 'fox', clientId: 'x' })).error === 'BAD_NAME', 'empty name rejected');
  check((await call('join', { name: 'A', icon: 'nope', clientId: 'x' })).error === 'BAD_ICON', 'unknown avatar rejected');

  console.log(`${N} raters join`);
  const sessions = [];
  for (let i = 0; i < N; i++) {
    const res = await call('join', { name: `Rater ${i + 1}`, icon: st.data.icons[i].id, clientId: `client-${i}` });
    check(res.ok && res.data.assigned.length === per && new Set(res.data.assigned).size === per, `rater ${i + 1} gets ${per} distinct scenes`);
    sessions.push(res.data);
  }
  const t1 = await call('join', { name: 'Someone else', icon: st.data.icons[0].id, clientId: 'client-x' });
  check(t1.error === 'ICON_TAKEN', 'avatar already in use is refused (' + t1.error + ')');
  const again = await call('join', { name: 'Rater 1', icon: st.data.icons[0].id, clientId: 'other-browser' });
  check(again.ok && again.data.resumed && again.data.raterId === sessions[0].raterId, 'same name + avatar on another browser resumes the same set');
  const dupName = await call('join', { name: 'rater 1', icon: st.data.icons[19].id, clientId: 'client-y' });
  check(dupName.error === 'NAME_ACTIVE', 'same name with a different avatar while active is refused');

  const counts = {};
  sessions.forEach(s => s.assigned.forEach(v => { counts[v] = (counts[v] || 0) + 1; }));
  const cov = manifest.vectors.map(v => counts[v.id] || 0);
  console.log('  coverage after ' + N + ' raters: min ' + Math.min(...cov) + ', max ' + Math.max(...cov) + ', scenes ' + cov.filter(c => c > 0).length + '/' + cov.length);
  if (N * per >= manifest.vectors.length) check(Math.min(...cov) >= 1, 'every scene is assigned at least once');
  check(Math.max(...cov) - Math.min(...cov) <= 1, 'load is balanced (max - min <= 1)');

  console.log('submit rules');
  const s0 = sessions[0];
  const partial = ratingsFor(s0.assigned, () => 3).slice(1);
  check((await call('submit', { raterId: s0.raterId, token: s0.token, ratings: partial })).error === 'INCOMPLETE', 'incomplete set refused');
  const bad = ratingsFor(s0.assigned, () => 7);
  check((await call('submit', { raterId: s0.raterId, token: s0.token, ratings: bad })).error === 'BAD_RATING', 'score outside 1-5 refused');
  const low = ratingsFor(s0.assigned, () => 0.5);
  check((await call('submit', { raterId: s0.raterId, token: s0.token, ratings: low })).error === 'BAD_RATING', 'score 0.5 refused');
  const noIntel = ratingsFor(s0.assigned, () => 3).map(r => ({ ...r, intelligibility: undefined }));
  check((await call('submit', { raterId: s0.raterId, token: s0.token, ratings: noIntel })).error === 'BAD_RATING', 'missing intelligibility refused');
  const foreign = ratingsFor(s0.assigned, () => 3);
  foreign[0].sampleId = manifest.vectors.find(v => !s0.assigned.includes(v.id)).samples[0];
  check((await call('submit', { raterId: s0.raterId, token: s0.token, ratings: foreign })).error === 'BAD_RATING', 'clip outside the set refused');
  check((await call('submit', { raterId: s0.raterId, token: 'wrong', ratings: ratingsFor(s0.assigned, () => 3) })).error === 'BAD_SESSION', 'wrong token refused');

  // Deterministic fake opinions so the summary can be checked: score depends on the clip id only.
  const truth = {};
  const score = (sid, dim) => (truth[sid + dim] = truth[sid + dim] || 1 + (parseInt(require('crypto').createHash('md5').update(sid + dim).digest('hex').slice(0, 6), 16) % 17) / 4);
  for (const s of sessions) {
    const r = await call('submit', { raterId: s.raterId, token: s.token, ratings: ratingsFor(s.assigned, score), headphones: 'over-ear', connection: 'wired', minutes: 17.3 });
    check(r.ok && r.data.count === s.assigned.reduce((n, v) => n + vec[v].samples.length, 0), `rater ${s.name} submitted ${r.data && r.data.count} clips`);
  }
  const twice = await call('submit', { raterId: s0.raterId, token: s0.token, ratings: ratingsFor(s0.assigned, score) });
  check(twice.ok && twice.data.alreadySubmitted, 'second submit is a no-op (no duplicate rows)');
  check((await call('join', { name: 'New name', icon: st.data.icons[18].id, clientId: 'client-0' })).error === 'ALREADY_DONE', 'finished browser cannot start again');
  check((await call('join', { name: 'RATER 2', icon: st.data.icons[18].id, clientId: 'fresh' })).error === 'NAME_DONE', 'finished name cannot start again');
  check((await call('join', { name: 'Late', icon: st.data.icons[1].id, clientId: 'fresh2' })).error === 'ICON_TAKEN', 'finished avatar stays taken');

  console.log('admin');
  check((await call('admin', { adminKey: 'nope' })).error === 'BAD_ADMIN_KEY', 'wrong admin key refused');
  const adm = await call('admin', { adminKey: ADMIN });
  check(adm.ok, 'admin report loads');
  const rows = adm.data.rows;
  const expectedRows = sessions.reduce((n, s) => n + s.assigned.reduce((m, v) => m + vec[v].samples.length, 0), 0);
  check(rows.length === expectedRows, `report has ${rows.length} decoded rows (expected ${expectedRows})`);
  check(rows.every(r => r.device && r.device !== '?' && r.device !== 'Input'), 'every row decodes to a rated device');
  check(rows.every(r => r.sourceFile.includes(r.device) && r.sourceFile.startsWith(r.scene.split('_')[0])), 'decoded device matches the source file name');

  // Independent recomputation of device means
  const byDev = {};
  rows.forEach(r => { (byDev[r.device] = byDev[r.device] || []).push(r); });
  check(rows.every(r => r.voiceQuality === truth[r.sampleId + 'vq'] && r.intelligibility === truth[r.sampleId + 'it']), 'decimal scores stored exactly (e.g. 3.25, 4.5)');
  adm.data.summary.byDevice.forEach(d => {
    const list = byDev[d.device];
    const mean = k => list.reduce((a, r) => a + r[k], 0) / list.length;
    const ov = list.reduce((a, r) => a + (r.voiceQuality + r.noiseSuppression + r.intelligibility) / 3, 0) / list.length;
    check(Math.abs(mean('voiceQuality') - d.voice.mean) < 1e-3 && Math.abs(mean('intelligibility') - d.intel.mean) < 1e-3 &&
          Math.abs(ov - d.overall.mean) < 1e-3 && d.n === list.length,
          `${d.device}: voice ${d.voice.mean} noise ${d.noise.mean} intel ${d.intel.mean} overall ${d.overall.mean} ± ${d.overall.ci95}, n=${d.n}, win ${d.winRate}`);
  });
  const wr = adm.data.summary.byDevice.reduce((a, d) => a + d.wins, 0);
  const trials = new Set(rows.map(r => r.raterId + r.vectorId)).size;
  check(Math.abs(wr - trials) < 0.05, `wins add up to the number of (listener, scene) trials (${wr.toFixed(2)} vs ${trials})`);
  check(adm.data.coverage.every(c => c.done === (counts[c.vectorId] || 0)), 'coverage matches assignments');

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
