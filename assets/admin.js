// Hush Hour - organiser dashboard. Everything is computed server-side (Code.gs) and only rendered here.
(function () {
  'use strict';
  var H = window.Hush, el = H.el, $ = function (id) { return document.getElementById(id); };
  var KEY = 'hushhour.adminKey';
  var DEV_COLORS = ['c-violet', 'c-sky', 'c-mint', 'c-yellow', 'c-pink'];
  var report = null;

  function f2(x) { return x === null || x === undefined ? '–' : Number(x).toFixed(2); }
  function pm(s) { return s.mean === null ? '–' : f2(s.mean) + (s.ci95 === null ? '' : ' ± ' + f2(s.ci95)); }
  function pct(x) { return x === null || x === undefined ? '–' : Math.round(x * 100) + '%'; }
  function when(iso) { return iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '–'; }
  function devClass(d) { return DEV_COLORS[Math.max(0, report.summary.devices.indexOf(d)) % DEV_COLORS.length]; }

  async function load(key) {
    $('keyBtn').disabled = true;
    $('refreshBtn').disabled = true;
    try {
      report = await H.call('admin', { adminKey: key }, 90000);
      try { sessionStorage.setItem(KEY, key); } catch (e) { /* ignore */ }
      $('lockScreen').hidden = true;
      $('dash').hidden = false;
      render();
    } catch (err) {
      H.toast(err.message, 'error');
      if (err.code === 'BAD_ADMIN_KEY') { try { sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ } $('lockScreen').hidden = false; $('dash').hidden = true; }
    } finally {
      $('keyBtn').disabled = false;
      $('refreshBtn').disabled = false;
    }
  }

  function render() {
    var s = report.summary;
    $('genAt').textContent = 'Updated ' + when(report.generatedAt);

    var done = report.raters.filter(function (r) { return r.status === 'done'; }).length;
    var active = report.raters.filter(function (r) { return r.status === 'active'; }).length;
    var covered = report.coverage.filter(function (c) { return c.done > 0; }).length;
    var minCov = report.coverage.reduce(function (m, c) { return Math.min(m, c.done); }, Infinity);
    var kpis = $('kpis');
    kpis.innerHTML = '';
    [[done, 'listeners finished', 'c-mint'], [active, 'rating right now', 'c-yellow'], [s.ratings, 'clip ratings', 'c-sky'],
     [covered + '/' + report.coverage.length, 'scenes covered', 'c-pink'], [isFinite(minCov) ? minCov + '×' : '–', 'least-rated scene', 'c-violet']]
      .forEach(function (k) { kpis.appendChild(el('div', { class: 'stat ' + k[2] }, [el('b', { text: String(k[0]) }), el('span', { text: k[1] })])); });

    var board = $('board');
    board.innerHTML = '';
    if (!s.byDevice.length) board.appendChild(el('div', { class: 'card empty' }, [el('div', { class: 'big-emoji', text: '🦗' }),
      el('p', { class: 'sub', text: 'No finished ratings yet. Share the test link and come back here once the first listener submits.' })]));
    var ranked = s.byDevice.slice().sort(function (a, b) { return (b.overall.mean || 0) - (a.overall.mean || 0); });
    ranked.forEach(function (d, i) {
      function meter(label, st) {
        var w = st.mean === null ? 0 : ((st.mean - 1) / 4) * 100;
        return el('div', { class: 'meter' }, [
          el('div', { class: 'meter-top' }, [el('span', { text: label }), el('b', { text: pm(st) })]),
          el('div', { class: 'meter-bar' }, [el('i', { style: 'width:' + w.toFixed(1) + '%' })])
        ]);
      }
      board.appendChild(el('article', { class: 'dev-card ' + devClass(d.device) }, [
        el('div', { class: 'dev-head' }, [
          el('span', { class: 'rank', text: '#' + (i + 1) }),
          el('h3', { text: d.device }),
          el('span', { class: 'big-mos' }, [el('b', { text: f2(d.overall.mean) }), el('span', { text: d.overall.ci95 === null ? 'overall' : '± ' + f2(d.overall.ci95) + ' overall' })])
        ]),
        meter('🗣️ Voice quality', d.voice),
        meter('🔇 Noise suppression', d.noise),
        meter('👂 Intelligibility', d.intel),
        el('div', { class: 'dev-foot' }, [
          el('span', {}, [el('b', { text: pct(d.winRate) }), ' win rate']),
          el('span', {}, [el('b', { text: String(d.n) }), ' ratings'])
        ])
      ]));
    });

    matrix($('groupTbl'), 'Noise type', s.byGroup, s.devices);
    matrix($('sceneTbl'), 'Scene', s.byScene, s.devices);

    var cov = $('coverage');
    cov.innerHTML = '';
    report.coverage.forEach(function (c) {
      var lvl = c.done === 0 ? 'cov0' : c.done === 1 ? 'cov1' : 'cov2';
      cov.appendChild(el('div', { class: 'cov ' + lvl, title: c.scene }, [
        el('b', { text: c.done + (c.active ? '+' + c.active : '') }),
        el('span', { text: c.title + ' · ' + c.level })
      ]));
    });

    var rt = $('raterTbl');
    rt.innerHTML = '';
    rt.appendChild(el('thead', {}, el('tr', {}, ['', 'Name', 'Status', 'Joined', 'Submitted', 'Minutes', 'Headphones', 'Connection']
      .map(function (h) { return el('th', { text: h }); }))));
    var tb = el('tbody');
    report.raters.slice().reverse().forEach(function (r) {
      tb.appendChild(el('tr', {}, [
        el('td', { class: 'emoji-cell', text: r.emoji }), el('td', { text: r.name }),
        el('td', {}, el('span', { class: 'status st-' + r.status, text: r.status })),
        el('td', { text: when(r.joinedAt) }), el('td', { text: when(r.submittedAt) }),
        el('td', { class: 'num', text: r.minutes === '' ? '–' : String(r.minutes) }),
        el('td', { text: r.headphones || '–' }), el('td', { text: r.connection || '–' })
      ]));
    });
    rt.appendChild(tb);
  }

  function matrix(table, label, rows, devices) {
    table.innerHTML = '';
    var keys = [], labels = {};
    rows.forEach(function (r) { if (!(r.key in labels)) { keys.push(r.key); labels[r.key] = r.label; } });
    var DIMS = [['voice', 'Voice'], ['noise', 'Noise'], ['intel', 'Intel.']];
    var head1 = el('tr', {}, [el('th', { rowspan: '2', text: label })].concat(devices.map(function (d) {
      return el('th', { colspan: String(DIMS.length + 1), class: 'dev-th ' + devClass(d), text: d });
    })));
    var head2 = el('tr', {}, [].concat.apply([], devices.map(function () {
      return DIMS.map(function (x) { return el('th', { class: 'num', text: x[1] }); }).concat([el('th', { class: 'num', text: 'n' })]);
    })));
    table.appendChild(el('thead', {}, [head1, head2]));
    var tb = el('tbody');
    if (!keys.length) tb.appendChild(el('tr', {}, el('td', { colspan: String(1 + devices.length * (DIMS.length + 1)), class: 'muted', text: 'No ratings yet.' })));
    keys.forEach(function (k) {
      var cells = [el('td', { text: labels[k] })];
      var best = {};
      devices.forEach(function (d) {
        var r = rows.filter(function (x) { return x.key === k && x.device === d; })[0];
        if (r) DIMS.forEach(function (x) { if (r[x[0]].mean !== null) best[x[0]] = Math.max(best[x[0]] === undefined ? -1 : best[x[0]], r[x[0]].mean); });
      });
      devices.forEach(function (d) {
        var r = rows.filter(function (x) { return x.key === k && x.device === d; })[0];
        DIMS.forEach(function (x) {
          var m = r ? r[x[0]].mean : null;
          cells.push(el('td', { class: 'num' + (m === null ? ' muted' : m === best[x[0]] ? ' best' : ''), text: f2(m) }));
        });
        cells.push(el('td', { class: 'num muted', text: r ? String(r.n) : '' }));
      });
      tb.appendChild(el('tr', {}, cells));
    });
    table.appendChild(tb);
  }

  /* ---------------------------------------------------------------- downloads */

  function flatStats(x) {
    return {
      n: x.n,
      voice_mos: x.voice.mean, voice_ci95: x.voice.ci95,
      noise_mos: x.noise.mean, noise_ci95: x.noise.ci95,
      intelligibility_mos: x.intel.mean, intelligibility_ci95: x.intel.ci95,
      overall_mos: x.overall.mean, overall_ci95: x.overall.ci95
    };
  }
  function tables() {
    var s = report.summary;
    return {
      By_Device: s.byDevice.map(function (x) {
        return Object.assign({ device: x.device }, flatStats(x), { win_rate: x.winRate, wins: x.wins, comparisons: x.comparisons });
      }),
      By_NoiseType: s.byGroup.map(function (x) { return Object.assign({ noise_type: x.label, device: x.device }, flatStats(x)); }),
      By_Scene: s.byScene.map(function (x) { return Object.assign({ vector: x.key, scene: x.label, device: x.device }, flatStats(x)); }),
      Ratings_Decoded: report.rows.map(function (r) {
        return { submitted_at: r.submittedAt, rater: r.name, avatar: r.icon, rater_id: r.raterId, vector: r.vectorId, scene: r.scene,
          noise_type: r.group, title: r.title, level: r.level, device: r.device, clip_id: r.sampleId, source_file: r.sourceFile,
          position_shown: r.position, voice_quality: r.voiceQuality, noise_suppression: r.noiseSuppression,
          intelligibility: r.intelligibility };
      }),
      Coverage: report.coverage.map(function (c) {
        return { vector: c.vectorId, scene: c.scene, title: c.title, level: c.level, finished_ratings: c.done, in_progress: c.active };
      }),
      Listeners: report.raters.map(function (r) {
        return { name: r.name, avatar: r.icon, status: r.status, joined_at: r.joinedAt, submitted_at: r.submittedAt,
          minutes: r.minutes, headphones: r.headphones, connection: r.connection, scenes: r.assigned };
      })
    };
  }
  function stamp() { return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'); }
  function saveBlob(blob, name) {
    var a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  function csv(rows) {
    if (!rows.length) return '';
    var cols = Object.keys(rows[0]);
    function q(v) { v = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    return [cols.join(',')].concat(rows.map(function (r) { return cols.map(function (c) { return q(r[c]); }).join(','); })).join('\r\n');
  }

  $('csvBtn').addEventListener('click', function () {
    var rows = tables().Ratings_Decoded;
    if (!rows.length) return H.toast('No ratings to download yet.', '');
    saveBlob(new Blob(['﻿' + csv(rows)], { type: 'text/csv;charset=utf-8' }), 'hush-hour-ratings-' + stamp() + '.csv');
  });

  var xlsxReady = null;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    xlsxReady = xlsxReady || new Promise(function (ok, bad) {
      var s = el('script', { src: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js' });
      s.onload = ok;
      s.onerror = function () { xlsxReady = null; bad(new Error('Could not load the Excel library. Use the CSV download instead.')); };
      document.head.appendChild(s);
    });
    return xlsxReady;
  }
  $('xlsxBtn').addEventListener('click', async function () {
    try {
      await loadXlsx();
      var wb = window.XLSX.utils.book_new();
      var t = tables();
      Object.keys(t).forEach(function (name) {
        var ws = t[name].length ? window.XLSX.utils.json_to_sheet(t[name]) : window.XLSX.utils.aoa_to_sheet([['(empty)']]);
        window.XLSX.utils.book_append_sheet(wb, ws, name);
      });
      window.XLSX.writeFile(wb, 'hush-hour-results-' + stamp() + '.xlsx');
    } catch (err) { H.toast(err.message, 'error'); }
  });

  /* ---------------------------------------------------------------- boot */

  $('keyForm').addEventListener('submit', function (e) { e.preventDefault(); load($('keyInput').value.trim()); });
  $('refreshBtn').addEventListener('click', function () {
    var k = null;
    try { k = sessionStorage.getItem(KEY); } catch (e) { /* ignore */ }
    if (k) load(k);
  });
  if (!H.configured) H.toast('config.js has no API_URL yet.', 'error');
  var saved = null;
  try { saved = sessionStorage.getItem(KEY); } catch (e) { /* ignore */ }
  if (saved) load(saved);
})();
