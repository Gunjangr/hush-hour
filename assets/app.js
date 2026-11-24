// Hush Hour - rater app. Progress lives in localStorage so a reload never loses scores.
(function () {
  'use strict';
  var H = window.Hush, el = H.el, $ = function (id) { return document.getElementById(id); };
  var STORE = 'hushhour.v1';
  var LETTERS = ['A', 'B', 'C', 'D', 'E'];
  var COLORS = ['c-pink', 'c-yellow', 'c-mint', 'c-sky', 'c-violet'];
  var FACES = ['😖', '😕', '😐', '🙂', '🤩'];
  var DIMS = [
    { key: 'vq', label: 'Voice quality', icon: '🗣️', ask: 'How clear and natural is the talker?',
      words: ['Very distorted', 'Fairly distorted', 'Somewhat natural', 'Fairly natural', 'Very natural'],
      long: ['Bad: very unnatural, robotic or badly distorted', 'Poor: fairly unnatural, quite distorted',
             'Fair: somewhat natural, some distortion', 'Good: fairly natural, a little distortion',
             'Excellent: very natural, no distortion'] },
    { key: 'ns', label: 'Noise suppression', icon: '🔇', ask: 'How well is the background removed?',
      words: ['Very intrusive', 'Somewhat intrusive', 'Noticeable, not intrusive', 'Slightly noticeable', 'Not noticeable'],
      long: ['Bad: background very noticeable and very intrusive', 'Poor: noticeable and somewhat intrusive',
             'Fair: noticeable but not intrusive', 'Good: only slightly noticeable',
             'Excellent: no background noise noticeable'] },
    { key: 'it', label: 'Intelligibility', icon: '👂', ask: 'How easy is it to understand every word?',
      words: ['Barely understood', 'Hard to follow', 'Understood with effort', 'Clear, little effort', 'Every word clear'],
      long: ['Bad: hardly any words can be understood', 'Poor: many words are hard to catch',
             'Fair: most words understood, with some effort', 'Good: clear, only slight effort needed',
             'Excellent: every word is clear, no effort at all'] }
  ];

  var S = load();
  var manifest = null, vecById = {}, status = null, pick = null;
  var players = [];

  /* ---------------------------------------------------------------- storage */

  function load() {
    var s = null;
    try { s = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { s = null; }
    s = s || {};
    if (!s.clientId) s.clientId = 'c_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    s.answers = s.answers || {};
    delete s.heard;
    return s;
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* private mode: keeps working in memory */ }
  }

  /* ---------------------------------------------------------------- helpers */

  function hash(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function seededShuffle(arr, key) {
    var seed = hash(key), a = arr.slice();
    function rnd() {
      seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rnd() * (i + 1)); var x = a[i]; a[i] = a[j]; a[j] = x; }
    return a;
  }
  function orderOf(v) { return seededShuffle(v.samples, S.session.raterId + '|' + v.id); }
  function fmt(t) {
    if (!isFinite(t)) return '0:00';
    t = Math.max(0, Math.round(t));
    return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
  }
  function isRated(sid) {
    var a = S.answers[sid] || {};
    return DIMS.every(function (d) { return typeof a[d.key] === 'number'; });
  }
  function scoreText(v) { return typeof v === 'number' ? String(Math.round(v * 100) / 100) : '–'; }
  // Accepts "3", "3.5", "3,5", "4.25"; returns a number in 1..5 (2 decimals), null for empty, NaN for invalid.
  function parseScore(raw) {
    var s = String(raw).trim().replace(',', '.');
    if (s === '') return null;
    if (!/^\d+(\.\d*)?$|^\.\d+$/.test(s)) return NaN;
    var v = Math.round(parseFloat(s) * 100) / 100;
    return v >= 1 && v <= 5 ? v : NaN;
  }
  function vectorDone(v) { return v.samples.every(isRated); }
  function assignedVecs() { return S.session.assigned.map(function (id) { return vecById[id]; }); }

  /* ---------------------------------------------------------------- screens */

  function show(name) {
    stopAll();
    document.querySelectorAll('.screen').forEach(function (s) { s.hidden = s.id !== 's-' + name; });
    $('hpPill').hidden = name !== 'rate';
    var me = S.session || S.done;
    $('mePill').hidden = !me;
    if (me) $('mePill').textContent = (me.emoji || '') + ' ' + me.name;
    window.scrollTo(0, 0);
  }

  function fatal(title, text) {
    $('errTitle').textContent = title;
    $('errText').textContent = text;
    show('error');
  }

  document.querySelectorAll('[data-go]').forEach(function (b) {
    b.addEventListener('click', function () { show(b.getAttribute('data-go')); });
  });

  /* ---------------------------------------------------------------- welcome */

  $('startBtn').addEventListener('click', function () {
    if (S.session) return resume();
    openAvatars();
  });

  function resume() {
    if (!S.hp || !S.hp.ok) return show('headphones');
    if (S.view === 'review') return openReview();
    openRate(S.idx || 0);
  }

  /* ---------------------------------------------------------------- avatars */

  async function openAvatars() {
    show('avatar');
    if (S.lastName && !$('nameInput').value) $('nameInput').value = S.lastName;
    await refreshIcons();
  }

  async function refreshIcons() {
    var grid = $('avatarGrid');
    if (!status) grid.innerHTML = '<p class="muted">Loading avatars…</p>';
    try {
      status = await H.call('status');
    } catch (err) {
      grid.innerHTML = '';
      grid.appendChild(el('p', { class: 'muted', text: err.message }));
      return;
    }
    if (pick && status.icons.some(function (i) { return i.id === pick && i.taken; })) pick = null;
    renderAvatars();
  }

  function renderAvatars() {
    var grid = $('avatarGrid');
    grid.innerHTML = '';
    var taken = 0;
    status.icons.forEach(function (ic, n) {
      if (ic.taken) taken++;
      var b = el('button', {
        class: 'avatar ' + COLORS[n % COLORS.length] + (ic.taken ? ' taken' : '') + (pick === ic.id ? ' picked' : ''),
        role: 'radio', 'aria-checked': pick === ic.id ? 'true' : 'false', disabled: ic.taken,
        'aria-label': ic.name + (ic.taken ? ' (taken)' : ''),
        onclick: function () { pick = ic.id; renderAvatars(); updateClaim(); }
      }, [el('span', { class: 'avatar-emoji', text: ic.emoji }), el('span', { class: 'avatar-name', text: ic.name }),
          ic.taken ? el('span', { class: 'stamp', text: 'taken' }) : null]);
      grid.appendChild(b);
    });
    $('takenCount').textContent = taken + ' of ' + status.icons.length + ' avatars taken';
    updateClaim();
  }

  function updateClaim() { $('claimBtn').disabled = !(pick && $('nameInput').value.trim()); }
  $('nameInput').addEventListener('input', updateClaim);
  $('nameInput').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !$('claimBtn').disabled) $('claimBtn').click(); });
  $('refreshIcons').addEventListener('click', refreshIcons);

  $('claimBtn').addEventListener('click', async function () {
    var btn = $('claimBtn');
    btn.disabled = true;
    btn.textContent = 'Claiming…';
    var name = $('nameInput').value.trim();
    S.lastName = name;
    try {
      var res = await H.call('join', { name: name, icon: pick, clientId: S.clientId, userAgent: navigator.userAgent });
      var known = res.assigned.every(function (id) { return vecById[id]; });
      if (!known) throw Object.assign(new Error('The scene list changed since this session started. Ask the organiser.'), { code: 'MISMATCH' });
      S.session = res;
      if (!res.resumed || !S.startedAt) { S.startedAt = Date.now(); S.idx = 0; S.maxReached = 0; }
      S.view = 'rate';
      save();
      H.toast(res.resumed ? 'Welcome back ' + res.emoji + ' picking up where you left off.' : res.emoji + ' ' + res.iconName + ' is yours!', 'ok');
      show('headphones');
    } catch (err) {
      if (err.code === 'ALREADY_DONE') { S.done = S.done || { name: name }; save(); return openDone(); }
      H.toast(err.message, 'error');
      if (err.code === 'ICON_TAKEN') { pick = null; refreshIcons(); }
    } finally {
      btn.textContent = 'Claim my avatar →';
      updateClaim();
    }
  });

  /* ---------------------------------------------------------------- headphones */

  function chipGroup(id, field) {
    $(id).querySelectorAll('.chip-btn').forEach(function (b) {
      b.setAttribute('role', 'radio');
      b.addEventListener('click', function () {
        S.hp = S.hp || {};
        S.hp[field] = b.getAttribute('data-v');
        save();
        paintHp();
      });
    });
  }
  function paintHp() {
    var hp = S.hp || {};
    [['hpType', 'type'], ['hpConn', 'conn']].forEach(function (g) {
      $(g[0]).querySelectorAll('.chip-btn').forEach(function (b) {
        var on = hp[g[1]] === b.getAttribute('data-v');
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    });
    $('toRateBtn').disabled = !(hp.type && hp.conn);
  }
  chipGroup('hpType', 'type');
  chipGroup('hpConn', 'conn');
  $('toRateBtn').addEventListener('click', function () {
    S.hp.ok = true;
    save();
    openRate(S.idx || 0);
  });

  var actx = null;
  function beep(pan) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      var osc = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
      osc.type = 'sine';
      osc.frequency.value = pan < 0 ? 660 : 880;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      osc.connect(g);
      if (actx.createStereoPanner) {
        var p = actx.createStereoPanner(); p.pan.value = pan; g.connect(p); p.connect(actx.destination);
      } else {
        var m = actx.createChannelMerger(2); g.connect(m, 0, pan < 0 ? 0 : 1); m.connect(actx.destination);
      }
      osc.start(t); osc.stop(t + 0.75);
    } catch (e) { H.toast('Your browser blocked the test beep. That is fine, carry on.', ''); }
  }
  $('beepL').addEventListener('click', function () { beep(-1); });
  $('beepR').addEventListener('click', function () { beep(1); });

  /* ---------------------------------------------------------------- audio players */

  function stopAll() {
    players.forEach(function (p) { p.audio.pause(); p.audio.removeAttribute('src'); p.audio.load(); });
    players = [];
  }

  function makePlayer(src, opts) {
    var audio = new Audio();
    audio.preload = 'auto';
    audio.src = src;
    var btn = el('button', { class: 'play', 'aria-label': 'Play ' + opts.label });
    var fill = el('div', { class: 'fill' });
    var bar = el('div', { class: 'bar', role: 'slider', tabindex: '0', 'aria-label': 'Seek ' + opts.label,
      'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, [fill]);
    var time = el('span', { class: 'time', text: '0:00' });
    var eq = el('span', { class: 'eq mini', 'aria-hidden': 'true' }, [el('i'), el('i'), el('i'), el('i')]);
    var root = el('div', { class: 'player' }, [btn, el('div', { class: 'track' }, [bar, el('div', { class: 'track-meta' }, [time, eq])])]);
    var p = { audio: audio, root: root };

    function paint() {
      var d = audio.duration, c = audio.currentTime;
      var pct = isFinite(d) && d > 0 ? (c / d) * 100 : 0;
      fill.style.width = pct + '%';
      bar.setAttribute('aria-valuenow', String(Math.round(pct)));
      time.textContent = fmt(c) + ' / ' + fmt(d);
    }
    btn.addEventListener('click', function () {
      if (audio.paused) {
        players.forEach(function (o) { if (o !== p) o.audio.pause(); });
        var pr = audio.play();
        if (pr && pr.catch) pr.catch(function () { H.toast('Could not play this clip. Check your connection and tap play again.', 'error'); });
      } else audio.pause();
    });
    function seekTo(ratio) {
      if (!isFinite(audio.duration)) return;
      audio.currentTime = Math.max(0, Math.min(audio.duration - 0.05, ratio * audio.duration));
      paint();
    }
    bar.addEventListener('click', function (e) {
      var r = bar.getBoundingClientRect();
      seekTo((e.clientX - r.left) / r.width);
    });
    bar.addEventListener('keydown', function (e) {
      if (!isFinite(audio.duration)) return;
      var step = 5 / audio.duration, cur = audio.currentTime / audio.duration;
      if (e.key === 'ArrowRight') { seekTo(cur + step); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { seekTo(cur - step); e.preventDefault(); }
    });
    audio.addEventListener('loadedmetadata', paint);
    audio.addEventListener('timeupdate', paint);
    audio.addEventListener('play', function () { root.classList.add('playing'); btn.setAttribute('aria-label', 'Pause ' + opts.label); });
    audio.addEventListener('pause', function () { root.classList.remove('playing'); btn.setAttribute('aria-label', 'Play ' + opts.label); });
    audio.addEventListener('error', function () {
      if (audio.getAttribute('src')) time.textContent = 'could not load';
    });
    players.push(p);
    return p;
  }

  /* ---------------------------------------------------------------- rating */

  function openRate(idx) {
    var list = assignedVecs();
    idx = Math.max(0, Math.min(idx, list.length - 1));
    S.idx = idx;
    S.view = 'rate';
    S.maxReached = Math.max(S.maxReached || 0, idx);
    save();
    show('rate');
    var v = list[idx];

    $('trackNo').textContent = 'Scene ' + (idx + 1) + ' of ' + list.length;
    $('sceneEmoji').textContent = v.emoji;
    $('sceneTitle').textContent = v.title;
    $('sceneLevel').textContent = v.level;
    renderDots();

    var refSlot = $('refSlot');
    refSlot.innerHTML = '';
    if (v.ref) {
      var rp = makePlayer('audio/' + v.ref + '.wav', { label: 'original microphone' });
      refSlot.appendChild(el('div', { class: 'ref-card' }, [
        el('div', { class: 'ref-head' }, [
          el('span', { class: 'ref-badge', text: '🎙️' }),
          el('div', {}, [el('b', { text: 'Original mic: the raw, noisy input' }),
                         el('span', { class: 'small muted', text: 'Not rated. Listen to hear what the scene sounded like before any processing.' })]),
          el('span', { class: 'sticker-sm', text: 'reference' })
        ]), rp.root]));
    } else {
      refSlot.appendChild(el('div', { class: 'ref-card ref-none' }, [
        el('span', { class: 'ref-badge', text: '🎙️' }),
        el('span', { class: 'small', text: 'No raw recording for this scene. Just rate the mystery mixes.' })]));
    }

    var box = $('samples');
    box.innerHTML = '';
    var order = orderOf(v);
    box.className = 'samples n' + order.length;
    order.forEach(function (sid, i) { box.appendChild(sampleCard(v, sid, i)); });
    updateNav();
  }

  function sampleCard(v, sid, i) {
    var letter = LETTERS[i];
    var pill = el('span', { class: 'state' });
    var ring = el('span', { class: 'ring', 'aria-hidden': 'true' });
    var rows = DIMS.map(function (d) { return ratingRow(sid, d, letter); });
    var card = el('article', { class: 'sample ' + COLORS[i], id: 'card-' + sid }, [
      el('header', { class: 'sample-head' }, [
        el('span', { class: 'letter', text: letter }),
        el('div', { class: 'sample-title' }, [el('b', { text: 'Mystery mix ' + letter }), pill]),
        ring
      ])
    ]);
    var p = makePlayer('audio/' + sid + '.wav', { label: 'mystery mix ' + letter });
    card.appendChild(p.root);
    card.appendChild(el('div', { class: 'rate-area' }, rows.map(function (r) { return r.root; })));

    function paintCard() {
      rows.forEach(function (r) { r.paint(); });
      var a = S.answers[sid] || {};
      var n = DIMS.filter(function (d) { return typeof a[d.key] === 'number'; }).length;
      card.classList.toggle('rated', n === DIMS.length);
      pill.textContent = n === DIMS.length ? '✓ all scored' : n + ' of ' + DIMS.length + ' scored';
    }
    card.paint = paintCard;
    paintCard();
    return card;
  }

  function ratingRow(sid, d, letter) {
    var word = el('span', { class: 'rate-word' });
    function setScore(v) {
      S.answers[sid] = S.answers[sid] || {};
      if (typeof v === 'number') S.answers[sid][d.key] = v; else delete S.answers[sid][d.key];
      save();
      var card = document.getElementById('card-' + sid);
      if (card && card.paint) card.paint();
      renderDots();
      updateNav();
    }
    var box = el('input', {
      class: 'score-box', type: 'text', inputmode: 'decimal', maxlength: '4', placeholder: '1–5', autocomplete: 'off',
      'aria-label': d.label + ' for mix ' + letter + ', type any score from 1 to 5 such as 3.5', title: 'Type any score from 1 to 5, e.g. 3.5'
    });
    var btns = [1, 2, 3, 4, 5].map(function (n) {
      return el('button', {
        class: 'score s' + n, 'aria-label': d.label + ' for mix ' + letter + ': ' + n + ', ' + d.words[n - 1],
        title: d.words[n - 1],
        onclick: function () { box.classList.remove('bad'); setScore(n); }
      }, [el('span', { class: 'face', text: FACES[n - 1] }), el('span', { class: 'num', text: String(n) })]);
    });
    box.addEventListener('input', function () {
      var v = parseScore(box.value);
      box.classList.toggle('bad', v !== null && isNaN(v));
      setScore(v === null || isNaN(v) ? null : v);
    });
    box.addEventListener('blur', function () {
      var v = (S.answers[sid] || {})[d.key];
      if (!box.classList.contains('bad')) box.value = typeof v === 'number' ? scoreText(v) : '';
    });
    var root = el('div', { class: 'rate-row' }, [
      el('div', { class: 'rate-label' }, [el('b', { text: d.icon + ' ' + d.label }), word]),
      el('div', { class: 'scores', role: 'group', 'aria-label': d.label }, btns.concat([box]))
    ]);
    return {
      root: root,
      paint: function () {
        var val = (S.answers[sid] || {})[d.key];
        var has = typeof val === 'number';
        var bad = box.classList.contains('bad');
        btns.forEach(function (b, k) {
          var n = k + 1;
          var on = has && val === n;
          var half = has && !on && Math.floor(val) <= n && Math.ceil(val) >= n;   // 3.5 lights up 3 and 4
          b.classList.toggle('on', on);
          b.classList.toggle('half', half);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        if (document.activeElement !== box && !bad) box.value = has ? scoreText(val) : '';
        word.textContent = bad ? 'type a number from 1 to 5' : has ? d.words[Math.round(val) - 1] : d.ask;
        word.classList.toggle('set', has && !bad);
        word.classList.toggle('warn', bad);
      }
    };
  }

  function renderDots() {
    var list = assignedVecs(), box = $('dots');
    box.innerHTML = '';
    list.forEach(function (v, i) {
      var reachable = i <= (S.maxReached || 0);
      box.appendChild(el('button', {
        class: 'dot' + (vectorDone(v) ? ' done' : '') + (i === S.idx ? ' cur' : ''),
        disabled: !reachable, 'aria-current': i === S.idx ? 'step' : null,
        'aria-label': 'Scene ' + (i + 1) + (vectorDone(v) ? ', scored' : ''),
        onclick: function () { if (reachable) openRate(i); }
      }, String(i + 1)));
    });
  }

  function updateNav() {
    var list = assignedVecs(), v = list[S.idx];
    var left = v.samples.filter(function (s) { return !isRated(s); }).length;
    var last = S.idx === list.length - 1;
    $('nextBtn').textContent = last ? 'Review →' : 'Next →';
    $('nextBtn').classList.toggle('is-off', left > 0);
    $('navHint').textContent = left ? left + ' mix' + (left > 1 ? 'es' : '') + ' still to score' : '✓ all scored';
    $('prevBtn').textContent = S.idx === 0 ? '← Headphones' : '← Back';
  }

  $('prevBtn').addEventListener('click', function () {
    if (S.idx === 0) { S.hp.ok = false; save(); paintHp(); return show('headphones'); }
    openRate(S.idx - 1);
  });
  $('nextBtn').addEventListener('click', function () {
    var list = assignedVecs(), v = list[S.idx];
    var todo = v.samples.filter(function (s) { return !isRated(s); });
    if (todo.length) {
      var c = document.getElementById('card-' + todo[0]);
      if (c) { c.scrollIntoView({ behavior: 'smooth', block: 'center' }); c.classList.remove('nudge'); void c.offsetWidth; c.classList.add('nudge'); }
      H.toast('Give every mystery mix all three scores before moving on.', '');
      return;
    }
    if (S.idx === list.length - 1) return openReview();
    S.maxReached = Math.max(S.maxReached || 0, S.idx + 1);
    openRate(S.idx + 1);
  });

  /* guide */
  function fillGuide(id, d) {
    var ol = $(id);
    ol.innerHTML = '';
    for (var n = 5; n >= 1; n--) {
      ol.appendChild(el('li', { class: 's' + n }, [el('span', { class: 'face', text: FACES[n - 1] }),
        el('b', { text: String(n) }), el('span', { text: d.long[n - 1] })]));
    }
  }
  fillGuide('guideVoice', DIMS[0]);
  fillGuide('guideNoise', DIMS[1]);
  fillGuide('guideIntel', DIMS[2]);
  function openModal(id) { $(id).hidden = false; var f = $(id).querySelector('button:last-child'); if (f) f.focus(); }
  function closeModal(id) { $(id).hidden = true; }
  $('guideBtn').addEventListener('click', function () { openModal('guideModal'); });
  $('guideClose').addEventListener('click', function () { closeModal('guideModal'); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeModal('guideModal'); closeModal('confirmModal'); }
  });
  document.querySelectorAll('.modal').forEach(function (m) {
    m.addEventListener('click', function (e) { if (e.target === m) m.hidden = true; });
  });

  /* ---------------------------------------------------------------- review + submit */

  function openReview() {
    S.view = 'review';
    save();
    show('review');
    var box = $('reviewList');
    box.innerHTML = '';
    var all = true;
    assignedVecs().forEach(function (v, i) {
      var ok = vectorDone(v);
      all = all && ok;
      var chips = orderOf(v).map(function (sid, k) {
        var a = S.answers[sid] || {};
        return el('span', { class: 'mini-chip ' + COLORS[k] }, [
          el('b', { text: LETTERS[k] }), ' 🗣️' + scoreText(a.vq) + ' 🔇' + scoreText(a.ns) + ' 👂' + scoreText(a.it)]);
      });
      box.appendChild(el('button', { class: 'review-row' + (ok ? '' : ' todo'), onclick: function () { openRate(i); } }, [
        el('span', { class: 'review-n', text: String(i + 1) }),
        el('span', { class: 'review-scene' }, [el('b', { text: v.emoji + ' ' + v.title }), el('span', { class: 'muted small', text: v.level })]),
        el('span', { class: 'review-chips' }, chips),
        el('span', { class: 'review-state', text: ok ? '✓' : 'finish me' })
      ]));
    });
    $('submitBtn').disabled = !all;
  }
  $('reviewBack').addEventListener('click', function () { openRate(S.idx || 0); });
  $('submitBtn').addEventListener('click', function () { openModal('confirmModal'); });
  $('confirmNo').addEventListener('click', function () { closeModal('confirmModal'); });
  $('confirmYes').addEventListener('click', submit);

  async function submit() {
    closeModal('confirmModal');
    var btn = $('submitBtn');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    var ratings = [];
    assignedVecs().forEach(function (v) {
      orderOf(v).forEach(function (sid, k) {
        var a = S.answers[sid];
        ratings.push({ sampleId: sid, position: k + 1, voiceQuality: a.vq, noiseSuppression: a.ns, intelligibility: a.it });
      });
    });
    var minutes = S.startedAt ? (Date.now() - S.startedAt) / 60000 : 0;
    try {
      await H.call('submit', {
        raterId: S.session.raterId, token: S.session.token, ratings: ratings,
        headphones: S.hp && S.hp.type, connection: S.hp && S.hp.conn, minutes: minutes
      });
      S.done = { name: S.session.name, emoji: S.session.emoji, scenes: S.session.assigned.length,
                 clips: ratings.length, minutes: Math.round(minutes), at: Date.now() };
      delete S.session;
      S.answers = {};
      save();
      openDone(true);
    } catch (err) {
      H.toast(err.message, 'error');
      if (err.code === 'SESSION_EXPIRED' || err.code === 'BAD_SESSION') {
        delete S.session; S.answers = {}; S.hp = null; save();
        setTimeout(function () { location.reload(); }, 4000);
      }
    } finally {
      btn.textContent = 'Submit my ratings 🚀';
      btn.disabled = false;
    }
  }

  function openDone(party) {
    show('done');
    var d = S.done || {};
    $('doneAvatar').textContent = d.emoji || '🎉';
    $('doneText').textContent = (d.name ? 'Thanks, ' + d.name + '! ' : 'Thanks! ') + 'Your ratings are safely in.';
    var stats = $('doneStats');
    stats.innerHTML = '';
    if (d.scenes) {
      [[d.scenes, 'scenes'], [d.clips, 'mixes scored'], [Math.max(1, d.minutes || 0), 'minutes']].forEach(function (s, i) {
        stats.appendChild(el('div', { class: 'stat ' + COLORS[i + 1] }, [el('b', { text: String(s[0]) }), el('span', { text: s[1] })]));
      });
    }
    if (party) confetti();
  }

  function confetti() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var box = $('confetti');
    var colors = ['#ff5c8a', '#ffd23f', '#3ddc97', '#4cc9f0', '#9b6bff', '#ff8c42'];
    for (var i = 0; i < 140; i++) {
      var c = document.createElement('i');
      c.style.left = Math.random() * 100 + 'vw';
      c.style.background = colors[i % colors.length];
      c.style.animationDelay = Math.random() * 0.8 + 's';
      c.style.animationDuration = 2.4 + Math.random() * 2 + 's';
      c.style.setProperty('--x', (Math.random() * 200 - 100) + 'px');
      c.style.setProperty('--r', (Math.random() * 720 - 360) + 'deg');
      if (i % 3 === 0) c.style.borderRadius = '50%';
      box.appendChild(c);
    }
    setTimeout(function () { box.innerHTML = ''; }, 5500);
  }

  /* ---------------------------------------------------------------- boot */

  async function boot() {
    if (!H.configured) {
      return fatal('Not plugged in yet', 'The organiser still needs to paste the Apps Script web app URL into config.js. Check back soon!');
    }
    try {
      var res = await fetch('data/vectors.json', { cache: 'no-cache' });
      manifest = await res.json();
      manifest.vectors.forEach(function (v) { vecById[v.id] = v; });
    } catch (e) {
      return fatal('Could not load the test', 'The scene list did not load. Refresh the page; if it keeps happening, tell the organiser.');
    }
    if (S.session && !S.session.assigned.every(function (id) { return vecById[id]; })) {
      delete S.session; S.answers = {}; save();
    }
    $('perRaterTxt').textContent = String(Math.min(10, manifest.vectors.length));
    $('welcomeMeta').textContent = '≈ ' + (H.cfg.EXPECTED_MINUTES || '15-20') + ' min · headphones needed';
    paintHp();

    if (S.done) return openDone(false);
    if (S.session) {
      $('startBtn').firstChild.textContent = 'Continue as ' + S.session.emoji + ' ';
      show('welcome');
      return;
    }
    show('welcome');
    H.call('status').then(function (st) {
      status = st;
      $('perRaterTxt').textContent = String(st.perRater);
      var free = st.icons.filter(function (i) { return !i.taken; }).length;
      $('welcomeMeta').textContent = '≈ ' + (H.cfg.EXPECTED_MINUTES || '15-20') + ' min · ' + st.ratersDone +
        ' listener' + (st.ratersDone === 1 ? '' : 's') + ' done · ' + free + ' avatars left';
    }).catch(function () { /* welcome still works; avatar screen will retry */ });
  }

  boot();
})();
