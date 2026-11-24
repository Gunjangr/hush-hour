// Shared by index.html and admin.html: talks to the Apps Script web app.
(function () {
  'use strict';
  var cfg = window.HUSH_CONFIG || {};
  var isLocal = ['localhost', '127.0.0.1'].indexOf(location.hostname) >= 0;
  var override = new URLSearchParams(location.search).get('api');
  var url = override || (isLocal ? '/api' : cfg.API_URL);
  var configured = !!url && !/PASTE_YOUR/i.test(url);

  function HushError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  // text/plain keeps the request "simple", so Apps Script needs no CORS preflight.
  async function call(action, payload, timeoutMs) {
    if (!configured) throw HushError('NOT_CONFIGURED', 'This test is not connected to its Google Sheet yet.');
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 45000);
    var res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action: action }, payload || {})),
        signal: ctrl.signal,
        redirect: 'follow'
      });
    } catch (err) {
      throw HushError('NETWORK', 'Could not reach the server. Check your connection and try again.');
    } finally {
      clearTimeout(timer);
    }
    var data;
    try { data = await res.json(); }
    catch (err) { throw HushError('NETWORK', 'The server sent an unexpected reply (HTTP ' + res.status + '). Try again in a moment.'); }
    if (!data.ok) throw HushError(data.error || 'SERVER_ERROR', data.message || 'Something went wrong.');
    return data.data;
  }

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, v);
    });
    [].concat(children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return n;
  }

  var toastTimer;
  function toast(message, kind) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = message;
    t.className = 'toast show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, kind === 'error' ? 7000 : 3500);
  }

  window.Hush = { cfg: cfg, url: url, configured: configured, isLocal: isLocal, call: call, el: el, toast: toast };
})();
