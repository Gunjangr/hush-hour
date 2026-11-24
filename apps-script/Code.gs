/**
 * Hush Hour - blind listening test backend.
 *
 * Lives in a Google Sheet (Extensions > Apps Script). Paste this file as Code.gs and the
 * PRIVATE Key.gs made by tools/build_dataset.py as a second file, run setup() once, then
 * Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 *
 * Tabs it keeps:
 *   Raters   one row per person (avatar, status, the vectors they were given)
 *   Ratings  one row per rated clip - clip ids only, device names never stored here
 *   Key      clip id -> device (written from Key.gs, only you can see this sheet)
 */

var CONFIG = {
  PER_RATER: 10,          // vectors (scenes) each person rates
  HOLD_HOURS: 12,         // an unfinished session keeps its avatar for this long
  ASSIGN_HOLD_HOURS: 3,   // unfinished sessions count towards coverage for this long
  MAX_NAME: 40
};

var ICONS = [
  { id: 'fox', emoji: '🦊', name: 'Fennec Fox' },
  { id: 'bat', emoji: '🦇', name: 'Echo Bat' },
  { id: 'owl', emoji: '🦉', name: 'Night Owl' },
  { id: 'panda', emoji: '🐼', name: 'Disco Panda' },
  { id: 'unicorn', emoji: '🦄', name: 'Hi-Fi Unicorn' },
  { id: 'octopus', emoji: '🐙', name: 'Octo Mixer' },
  { id: 'frog', emoji: '🐸', name: 'Bass Frog' },
  { id: 'trex', emoji: '🦖', name: 'Tiny-Arms Rex' },
  { id: 'penguin', emoji: '🐧', name: 'Cool Penguin' },
  { id: 'lion', emoji: '🦁', name: 'Loud Lion' },
  { id: 'koala', emoji: '🐨', name: 'Chill Koala' },
  { id: 'flamingo', emoji: '🦩', name: 'Funky Flamingo' },
  { id: 'whale', emoji: '🐳', name: 'Whale Song' },
  { id: 'parrot', emoji: '🦜', name: 'Copycat Parrot' },
  { id: 'bee', emoji: '🐝', name: 'Buzz Bee' },
  { id: 'hedgehog', emoji: '🦔', name: 'Hush Hedgehog' },
  { id: 'tiger', emoji: '🐯', name: 'Tempo Tiger' },
  { id: 'otter', emoji: '🦦', name: 'Audiophile Otter' },
  { id: 'turtle', emoji: '🐢', name: 'Slow-Jam Turtle' },
  { id: 'dragon', emoji: '🐲', name: 'Drop Dragon' }
];

var TABS = {
  raters: ['raterId', 'name', 'icon', 'status', 'assigned', 'joinedAt', 'submittedAt',
           'headphones', 'connection', 'minutes', 'clientId', 'token', 'userAgent'],
  ratings: ['submittedAt', 'raterId', 'name', 'icon', 'vectorId', 'sampleId', 'position',
            'voiceQuality', 'noiseSuppression', 'intelligibility'],
  key: ['clipId', 'vectorId', 'scene', 'title', 'role', 'device', 'sourceFile']
};
var TAB_NAMES = { raters: 'Raters', ratings: 'Ratings', key: 'Key' };

/* ------------------------------------------------------------------ web entry points */

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'ping';
  if (action === 'status') return respond_(function () { return status_(); });
  return respond_(function () { return { service: 'hush-hour', ok: true, vectors: key_().vectors.length }; });
}

function doPost(e) {
  return respond_(function () {
    var body;
    try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
    catch (err) { fail_('BAD_REQUEST', 'Request body is not JSON.'); }
    switch (body.action) {
      case 'status': return status_();
      case 'join': return withLock_(function () { return join_(body); });
      case 'submit': return withLock_(function () { return submit_(body); });
      case 'admin': return admin_(body);
      default: fail_('BAD_REQUEST', 'Unknown action: ' + body.action);
    }
  });
}

function respond_(fn) {
  var out;
  try { out = { ok: true, data: fn() }; }
  catch (err) {
    out = { ok: false, error: err.code || 'SERVER_ERROR', message: err.message || String(err) };
    if (!err.code) console.error(err && err.stack ? err.stack : err);
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message) {
  var err = new Error(message);
  err.code = code;
  throw err;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) fail_('BUSY', 'Lots of people are rating right now. Wait a few seconds and try again.');
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ------------------------------------------------------------------ actions */

function status_() {
  var now = Date.now();
  var raters = readRaters_();
  var held = {};
  var done = 0, active = 0;
  raters.forEach(function (r) {
    if (r.status === 'done') { held[r.icon] = true; done++; }
    else if (r.status === 'active' && !isStale_(r, now)) { held[r.icon] = true; active++; }
  });
  return {
    icons: ICONS.map(function (i) { return { id: i.id, emoji: i.emoji, name: i.name, taken: !!held[i.id] }; }),
    perRater: perRater_(),
    totalVectors: key_().vectors.length,
    ratersDone: done,
    ratersActive: active
  };
}

function join_(body) {
  var name = cleanName_(body.name);
  var nameKey = nameKey_(name);
  var icon = iconById_(body.icon);
  var clientId = String(body.clientId || '').replace(/,/g, '').slice(0, 64);
  if (!nameKey) fail_('BAD_NAME', 'Type your name first.');
  if (!icon) fail_('BAD_ICON', 'Pick an avatar from the list.');
  if (!clientId) fail_('BAD_REQUEST', 'Missing browser id.');

  var now = Date.now();
  var raters = readRaters_();
  var sheet = tab_('raters');

  for (var i = 0; i < raters.length; i++) {
    var r = raters[i];
    if (r.status !== 'done') continue;
    if (hasClient_(r, clientId)) fail_('ALREADY_DONE', 'This browser has already submitted a full set of ratings. Thank you!');
    if (nameKey_(r.name) === nameKey) fail_('NAME_DONE', 'Someone called "' + r.name + '" has already rated. If that is not you, add your surname.');
  }

  // Same browser still has an unfinished session: hand it back.
  for (i = 0; i < raters.length; i++) {
    r = raters[i];
    if (r.status === 'active' && hasClient_(r, clientId) && !isStale_(r, now)) return sessionOut_(r, true);
  }

  for (i = 0; i < raters.length; i++) {
    r = raters[i];
    if (r.status !== 'active') continue;
    if (isStale_(r, now)) { setCell_(sheet, r, 'status', 'expired'); r.status = 'expired'; continue; }
    if (r.icon === icon.id) {
      // Same person on another browser: let them continue with the same set.
      if (nameKey_(r.name) === nameKey) {
        if (!hasClient_(r, clientId)) setCell_(sheet, r, 'clientId', (r.clientId + ',' + clientId).slice(-500));
        return sessionOut_(r, true);
      }
      fail_('ICON_TAKEN', icon.name + ' was just taken. Pick another avatar.');
    }
    if (nameKey_(r.name) === nameKey) {
      fail_('NAME_ACTIVE', 'Someone called "' + r.name + '" is already rating as ' + iconById_(r.icon).emoji +
        ' ' + iconById_(r.icon).name + '. If that is you, pick that avatar to continue; otherwise add your surname.');
    }
  }
  for (i = 0; i < raters.length; i++) {
    if (raters[i].status === 'done' && raters[i].icon === icon.id) fail_('ICON_TAKEN', icon.name + ' is already taken. Pick another avatar.');
  }

  var assigned = assignVectors_(raters, now);
  var rec = {
    raterId: 'r_' + Utilities.getUuid().replace(/-/g, '').slice(0, 10),
    name: name,
    icon: icon.id,
    status: 'active',
    assigned: assigned.join(','),
    joinedAt: new Date(now),
    submittedAt: '',
    headphones: '',
    connection: '',
    minutes: '',
    clientId: clientId,
    token: 't_' + Utilities.getUuid().replace(/-/g, ''),
    userAgent: String(body.userAgent || '').slice(0, 200)
  };
  sheet.appendRow(TABS.raters.map(function (h) { return rec[h]; }));
  return sessionOut_(rec, false);
}

function submit_(body) {
  var raters = readRaters_();
  var r = null;
  for (var i = 0; i < raters.length; i++) if (raters[i].raterId === body.raterId) r = raters[i];
  if (!r || r.token !== body.token) fail_('BAD_SESSION', 'This rating session is not recognised. Reload the page.');
  if (r.status === 'done') return { alreadySubmitted: true, count: 0 };
  if (r.status === 'expired') fail_('SESSION_EXPIRED', 'This session expired and its avatar was released. Reload the page and start again.');

  var vecById = vectorMap_();
  var expected = {};
  r.assigned.split(',').forEach(function (vid) {
    var v = vecById[vid];
    if (!v) fail_('BAD_SESSION', 'Unknown scene ' + vid + ' in this session.');
    v.samples.forEach(function (sid) { expected[sid] = vid; });
  });

  var seen = {};
  var rows = [];
  var now = new Date();
  (body.ratings || []).forEach(function (x) {
    var sid = String(x.sampleId);
    if (!expected[sid]) fail_('BAD_RATING', 'Clip ' + sid + ' is not part of your set.');
    if (seen[sid]) fail_('BAD_RATING', 'Clip ' + sid + ' was rated twice.');
    var vq = Number(x.voiceQuality), ns = Number(x.noiseSuppression), it = Number(x.intelligibility), pos = Number(x.position);
    if (!isScore_(vq) || !isScore_(ns) || !isScore_(it)) {
      fail_('BAD_RATING', 'Every clip needs a score from 1 to 5 for voice quality, noise suppression and intelligibility.');
    }
    seen[sid] = true;
    rows.push([now, r.raterId, r.name, r.icon, expected[sid], sid, pos || '', round2_(vq), round2_(ns), round2_(it)]);
  });
  var missing = Object.keys(expected).filter(function (sid) { return !seen[sid]; });
  if (missing.length) fail_('INCOMPLETE', missing.length + ' clip(s) still need a score.');

  var ratings = tab_('ratings');
  ratings.getRange(ratings.getLastRow() + 1, 1, rows.length, TABS.ratings.length).setValues(rows);

  var sheet = tab_('raters');
  setCell_(sheet, r, 'status', 'done');
  setCell_(sheet, r, 'submittedAt', now);
  setCell_(sheet, r, 'headphones', String(body.headphones || '').slice(0, 40));
  setCell_(sheet, r, 'connection', String(body.connection || '').slice(0, 40));
  setCell_(sheet, r, 'minutes', Math.round(Number(body.minutes) * 10) / 10 || '');
  return { alreadySubmitted: false, count: rows.length };
}

function admin_(body) {
  var expected = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  if (!expected || String(body.adminKey || '') !== expected) fail_('BAD_ADMIN_KEY', 'Wrong admin key. Find it in the sheet menu Hush Hour > Show admin key.');
  return buildReport_();
}

/* ------------------------------------------------------------------ assignment */

// Greedy: least-covered scenes first, then avoid repeating a noise type, then random.
function assignVectors_(raters, now) {
  var vectors = key_().vectors;
  var load = {};
  vectors.forEach(function (v) { load[v.id] = 0; });
  raters.forEach(function (r) {
    var counts = r.status === 'done' ||
      (r.status === 'active' && now - toMs_(r.joinedAt) < CONFIG.ASSIGN_HOLD_HOURS * 3600e3);
    if (!counts || !r.assigned) return;
    r.assigned.split(',').forEach(function (vid) { if (vid in load) load[vid]++; });
  });
  var n = Math.min(perRater_(), vectors.length);
  var picked = [], groupCount = {}, jitter = {};
  vectors.forEach(function (v) { jitter[v.id] = Math.random(); });
  while (picked.length < n) {
    var best = null, bestScore = Infinity;
    vectors.forEach(function (v) {
      if (picked.indexOf(v.id) >= 0) return;
      var score = load[v.id] * 1000 + (groupCount[v.group] || 0) * 10 + jitter[v.id];
      if (score < bestScore) { bestScore = score; best = v; }
    });
    picked.push(best.id);
    groupCount[best.group] = (groupCount[best.group] || 0) + 1;
  }
  for (var i = picked.length - 1; i > 0; i--) {   // presentation order
    var j = Math.floor(Math.random() * (i + 1));
    var t = picked[i]; picked[i] = picked[j]; picked[j] = t;
  }
  return picked;
}

/* ------------------------------------------------------------------ results */

function buildReport_() {
  var vectors = key_().vectors;
  var clips = key_().clips;
  var vecById = vectorMap_();
  var raters = readRaters_();
  var iconOf = {};
  ICONS.forEach(function (i) { iconOf[i.id] = i; });

  var rows = readTab_('ratings').map(function (x) {
    var v = vecById[x.vectorId] || {};
    var c = clips[x.sampleId] || {};
    return {
      submittedAt: iso_(x.submittedAt), raterId: x.raterId, name: x.name, icon: x.icon,
      vectorId: x.vectorId, scene: v.scene || '', group: v.group || '', title: v.title || '', level: v.level || '',
      sampleId: x.sampleId, device: c.device || '?', sourceFile: c.file || '', position: x.position,
      voiceQuality: num_(x.voiceQuality), noiseSuppression: num_(x.noiseSuppression), intelligibility: num_(x.intelligibility)
    };
  });

  var now = Date.now();
  var coverage = vectors.map(function (v) {
    var done = 0, active = 0;
    raters.forEach(function (r) {
      if (!r.assigned || r.assigned.split(',').indexOf(v.id) < 0) return;
      if (r.status === 'done') done++;
      else if (r.status === 'active' && !isStale_(r, now)) active++;
    });
    return { vectorId: v.id, scene: v.scene, title: v.title, level: v.level, group: v.group, done: done, active: active };
  });

  return {
    generatedAt: new Date().toISOString(),
    perRater: perRater_(),
    raters: raters.map(function (r) {
      return {
        raterId: r.raterId, name: r.name, icon: r.icon, emoji: (iconOf[r.icon] || {}).emoji || '',
        status: r.status === 'active' && isStale_(r, now) ? 'stale' : r.status,
        assigned: r.assigned, joinedAt: iso_(r.joinedAt), submittedAt: iso_(r.submittedAt),
        headphones: r.headphones, connection: r.connection, minutes: r.minutes
      };
    }),
    rows: rows,
    coverage: coverage,
    summary: summarise_(rows)
  };
}

function summarise_(rows) {
  var devices = [];
  rows.forEach(function (r) { if (devices.indexOf(r.device) < 0) devices.push(r.device); });
  var order = key_().deviceOrder || [];
  devices.sort(function (a, b) {
    var ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || (a < b ? -1 : 1);
  });

  function stats(list) {
    return {
      n: list.length,
      voice: meanCi_(list.map(function (r) { return r.voiceQuality; })),
      noise: meanCi_(list.map(function (r) { return r.noiseSuppression; })),
      intel: meanCi_(list.map(function (r) { return r.intelligibility; })),
      overall: meanCi_(list.map(overall_))
    };
  }

  // Wins: inside each (rater, scene) the device(s) with the best overall score share one win.
  var wins = {}, appearances = {}, trials = {};
  rows.forEach(function (r) {
    var k = r.raterId + '|' + r.vectorId;
    (trials[k] = trials[k] || []).push(r);
  });
  Object.keys(trials).forEach(function (k) {
    var t = trials[k];
    if (t.length < 2) return;
    var best = -1;
    t.forEach(function (r) { best = Math.max(best, overall_(r)); });
    var top = t.filter(function (r) { return Math.abs(overall_(r) - best) < 1e-9; });
    t.forEach(function (r) {
      appearances[r.device] = (appearances[r.device] || 0) + 1;
      if (top.indexOf(r) >= 0) wins[r.device] = (wins[r.device] || 0) + 1 / top.length;
    });
  });

  var byDevice = devices.map(function (d) {
    var s = stats(rows.filter(function (r) { return r.device === d; }));
    s.device = d;
    s.wins = Math.round((wins[d] || 0) * 100) / 100;
    s.comparisons = appearances[d] || 0;
    s.winRate = appearances[d] ? Math.round(1000 * (wins[d] || 0) / appearances[d]) / 1000 : null;
    return s;
  });

  function grouped(keyFn, labelFn) {
    var keys = [], seen = {};
    rows.forEach(function (r) { var k = keyFn(r); if (!seen[k]) { seen[k] = labelFn(r); keys.push(k); } });
    keys.sort();
    var out = [];
    keys.forEach(function (k) {
      devices.forEach(function (d) {
        var list = rows.filter(function (r) { return keyFn(r) === k && r.device === d; });
        if (!list.length) return;
        var s = stats(list);
        s.key = k; s.label = seen[k]; s.device = d;
        out.push(s);
      });
    });
    return out;
  }

  return {
    devices: devices,
    ratings: rows.length,
    raters: Object.keys(rows.reduce(function (m, r) { m[r.raterId] = 1; return m; }, {})).length,
    byDevice: byDevice,
    byGroup: grouped(function (r) { return r.group; }, function (r) { return r.group; }),
    byScene: grouped(function (r) { return r.vectorId; }, function (r) { return r.title + ' · ' + r.level; })
  };
}

// Overall = mean of whichever of the three scores the row has (older rows may lack intelligibility).
function overall_(r) {
  var xs = [r.voiceQuality, r.noiseSuppression, r.intelligibility].filter(isNum_);
  return xs.length ? xs.reduce(function (a, b) { return a + b; }, 0) / xs.length : null;
}

function meanCi_(xs) {
  xs = xs.filter(isNum_);
  var n = xs.length;
  if (!n) return { mean: null, ci95: null, sd: null };
  var m = xs.reduce(function (a, b) { return a + b; }, 0) / n;
  if (n < 2) return { mean: round3_(m), ci95: null, sd: null };
  var v = xs.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / (n - 1);
  var sd = Math.sqrt(v);
  return { mean: round3_(m), ci95: round3_(tCrit_(n - 1) * sd / Math.sqrt(n)), sd: round3_(sd) };
}

function tCrit_(df) {   // two-sided 95 %
  var t = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145,
           2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
  if (df <= 30) return t[df - 1];
  if (df <= 60) return 2.000;
  if (df <= 120) return 1.980;
  return 1.960;
}

/* ------------------------------------------------------------------ sheet menu (owner only) */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🎧 Hush Hour')
    .addItem('Build results tabs', 'buildResultsTabs')
    .addItem('Show admin key', 'showAdminKey')
    .addSeparator()
    .addItem('Run setup again', 'setup')
    .addToUi();
}

/** Run once after pasting Code.gs + Key.gs. Safe to run again (keeps ratings). */
function setup() {
  if (typeof BLIND_KEY === 'undefined') throw new Error('Key.gs is missing. Paste the private Key.gs file into this project first.');
  Object.keys(TABS).forEach(function (t) { ensureTab_(t); });
  var key = tab_('key');
  key.clearContents();
  var rows = [TABS.key];
  BLIND_KEY.vectors.forEach(function (v) {
    var ids = (v.ref ? [v.ref] : []).concat(v.samples);
    ids.forEach(function (id) {
      var c = BLIND_KEY.clips[id];
      rows.push([id, v.id, v.scene, v.title + ' · ' + v.level, id === v.ref ? 'reference' : 'sample', c.device, c.file]);
    });
  });
  key.getRange(1, 1, rows.length, TABS.key.length).setValues(rows);
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('ADMIN_KEY')) props.setProperty('ADMIN_KEY', 'hush-' + Utilities.getUuid().slice(0, 8));
  console.log('Setup done. ' + BLIND_KEY.vectors.length + ' scenes. Admin key: ' + props.getProperty('ADMIN_KEY'));
  return props.getProperty('ADMIN_KEY');
}

function showAdminKey() {
  var k = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY') || '(run setup first)';
  SpreadsheetApp.getUi().alert('Admin key for admin.html:\n\n' + k);
}

/** Writes decoded results into Results_* tabs so you can File > Download > .xlsx */
function buildResultsTabs() {
  var rep = buildReport_();
  var s = rep.summary;
  function ci(x) { return x.ci95 === null ? '' : x.ci95; }
  function write(name, header, rows) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.clearContents();
    var data = [header].concat(rows);
    sh.getRange(1, 1, data.length, header.length).setValues(data);
    sh.setFrozenRows(1);
  }
  var statHead = ['n', 'Voice MOS', 'Voice ±95%', 'Noise MOS', 'Noise ±95%', 'Intelligibility MOS', 'Intelligibility ±95%', 'Overall MOS', 'Overall ±95%'];
  function statCells(x) {
    return [x.n, x.voice.mean, ci(x.voice), x.noise.mean, ci(x.noise), x.intel.mean, ci(x.intel), x.overall.mean, ci(x.overall)];
  }
  write('Results_ByDevice', ['Device'].concat(statHead, ['Win rate', 'Comparisons']),
    s.byDevice.map(function (x) { return [x.device].concat(statCells(x), [x.winRate === null ? '' : x.winRate, x.comparisons]); }));
  write('Results_ByNoise', ['Noise type', 'Device'].concat(statHead),
    s.byGroup.map(function (x) { return [x.label, x.device].concat(statCells(x)); }));
  write('Results_ByScene', ['Vector', 'Scene', 'Device'].concat(statHead),
    s.byScene.map(function (x) { return [x.key, x.label, x.device].concat(statCells(x)); }));
  write('Results_Decoded', ['submittedAt', 'rater', 'icon', 'vectorId', 'scene', 'device', 'sampleId', 'position', 'voiceQuality', 'noiseSuppression', 'intelligibility'],
    rep.rows.map(function (r) {
      return [r.submittedAt, r.name, r.icon, r.vectorId, r.scene, r.device, r.sampleId, r.position, r.voiceQuality, r.noiseSuppression,
              r.intelligibility === null ? '' : r.intelligibility];
    }));
  try { SpreadsheetApp.getUi().alert('Results tabs updated from ' + s.ratings + ' ratings by ' + s.raters + ' raters.'); } catch (e) {}
}

/* ------------------------------------------------------------------ helpers */

function key_() {
  if (typeof BLIND_KEY === 'undefined') fail_('NOT_SET_UP', 'Key.gs is missing from the Apps Script project.');
  return BLIND_KEY;
}

function vectorMap_() {
  var m = {};
  key_().vectors.forEach(function (v) { m[v.id] = v; });
  return m;
}

function perRater_() { return Math.min(CONFIG.PER_RATER, key_().vectors.length); }

var headerSynced_ = {};
function tab_(t) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB_NAMES[t]) || ensureTab_(t);
  if (!headerSynced_[t]) {   // columns are only ever appended, so rewriting row 1 is safe
    var want = TABS[t];
    var have = sh.getRange(1, 1, 1, want.length).getValues()[0];
    if (have.join('|') !== want.join('|')) sh.getRange(1, 1, 1, want.length).setValues([want]);
    headerSynced_[t] = true;
  }
  return sh;
}

function ensureTab_(t) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(TAB_NAMES[t]);
  if (!sh) sh = ss.insertSheet(TAB_NAMES[t]);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, TABS[t].length).setValues([TABS[t]]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function readTab_(t) {
  var sh = tab_(t);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var head = values[0];
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (row.join('') === '') continue;
    var o = { _row: i + 1 };
    head.forEach(function (h, c) { o[h] = row[c]; });
    out.push(o);
  }
  return out;
}

function readRaters_() {
  return readTab_('raters').map(function (r) {
    r.raterId = String(r.raterId); r.icon = String(r.icon); r.status = String(r.status);
    r.clientId = String(r.clientId); r.token = String(r.token); r.name = String(r.name);
    r.assigned = String(r.assigned || '');
    return r;
  });
}

function setCell_(sheet, rec, field, value) {
  sheet.getRange(rec._row, TABS.raters.indexOf(field) + 1).setValue(value);
}

function sessionOut_(r, resumed) {
  var icon = iconById_(r.icon);
  return {
    resumed: resumed, raterId: r.raterId, token: r.token, name: r.name,
    icon: icon.id, emoji: icon.emoji, iconName: icon.name,
    assigned: String(r.assigned).split(',')
  };
}

// A rater who resumed on another browser keeps every browser id, so none of them can start over.
function hasClient_(r, clientId) { return String(r.clientId).split(',').indexOf(clientId) >= 0; }

function isStale_(r, now) { return now - toMs_(r.joinedAt) > CONFIG.HOLD_HOURS * 3600e3; }

function toMs_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return v.getTime();
  if (typeof v === 'number') return v;
  var t = Date.parse(v);
  return isNaN(t) ? 0 : t;
}

function iso_(v) {
  var t = toMs_(v);
  return v === '' || v === null || v === undefined || !t ? '' : new Date(t).toISOString();
}

function iconById_(id) {
  for (var i = 0; i < ICONS.length; i++) if (ICONS[i].id === id) return ICONS[i];
  return null;
}

function cleanName_(s) {
  return String(s || '').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim()
    .replace(/^[=+\-@'\s]+/, '').slice(0, CONFIG.MAX_NAME);
}

function nameKey_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9À-￿]/g, ''); }

// Any number from 1 to 5, decimals allowed (stored with 2 decimals).
function isScore_(x) { return isNum_(x) && x >= 1 && x <= 5; }
function isNum_(x) { return typeof x === 'number' && isFinite(x); }
function num_(v) { return v === '' || v === null || v === undefined || isNaN(Number(v)) ? null : Number(v); }
function round2_(x) { return Math.round(x * 100) / 100; }

function round3_(x) { return Math.round(x * 1000) / 1000; }
