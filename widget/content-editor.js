// The content editor at /admin/content/ (content.source: rows).
//
// ⚠️ Presentation only. Who may edit, what compiles, what a status means and
// what a save writes are all decided by the server (worker/src/content.js);
// this file asks and shows the answer, including every refusal, verbatim.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var root = $('content-editor');
  if (!root) return;
  var current = null;

  function api(method, path, body) {
    return fetch(path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; return j; }); })
      .catch(function () { return { _status: 0, error: 'The server could not be reached.' }; });
  }
  function text(node, s) { if (node) node.textContent = s == null ? '' : String(s); }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === 'text') n.textContent = attrs[k]; else n.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }
  function errors(j) { text($('content-errors'), (j.errors || [j.error]).filter(Boolean).join('\n')); }

  function list() {
    return api('GET', '/api/content').then(function (j) {
      if (j._status === 401 || j._status === 403) { $('content-denied').hidden = false; return; }
      if (j._status !== 200) { $('content-denied').hidden = false; text($('content-denied'), j.error || 'Unavailable.'); return; }
      root.hidden = false;
      text($('content-live'), j.live ? 'Live: version ' + j.live.id + ', digest ' + j.live.digest.slice(0, 12) : 'Nothing is live from the rows yet: the site shows the build it was deployed with.');
      $('content-import').hidden = j.items.length > 0;
      var rows = $('content-rows');
      rows.textContent = '';
      j.items.forEach(function (it) {
        var open = el('button', { type: 'button', text: it.title ? it.title + ' (' + it.path + ')' : it.path });
        if (it.editable) open.addEventListener('click', function () { edit(it.path); });
        else open.disabled = true;
        rows.appendChild(el('tr', {}, [el('td', {}, [open]), el('td', { text: it.status }), el('td', { text: it.revision }),
          el('td', { text: String(it.updated_at).slice(0, 16).replace('T', ' ') + ' · ' + it.updated_by })]));
      });
      return versions();
    });
  }

  function versions() {
    return api('GET', '/api/versions').then(function (j) {
      var ul = $('content-versions');
      ul.textContent = '';
      (j.versions || []).forEach(function (v) {
        var li = el('li', { text: 'Version ' + v.id + ' · ' + String(v.published_at).slice(0, 16).replace('T', ' ') + ' · ' + (v.published_by || '') + ' · ' + (v.reason || '') + ' ' });
        if (v.live) li.appendChild(el('span', { class: 'tag', text: 'live' }));
        else {
          var b = el('button', { type: 'button', text: 'Make live' });
          b.addEventListener('click', function () {
            api('POST', '/api/versions/live', { id: v.id }).then(function (r) { if (r._status !== 200) errors(r); list(); });
          });
          li.appendChild(b);
        }
        ul.appendChild(li);
      });
    });
  }

  function edit(path) {
    return api('GET', '/api/content/item?path=' + encodeURIComponent(path)).then(function (it) {
      current = it._status === 200 ? it : { path: path, revision: 0, status: 'draft', body: '---\ntitle: \n---\n\n# \n' };
      $('content-edit').hidden = false;
      text($('content-path'), current.path);
      $('content-status').value = current.status;
      $('content-body').value = current.body;
      text($('content-errors'), '');
      text($('content-saved'), '');
      $('content-frame').hidden = true;
      return revisions();
    });
  }

  function revisions() {
    return api('GET', '/api/content/revisions?path=' + encodeURIComponent(current.path)).then(function (j) {
      var ul = $('content-revisions');
      ul.textContent = '';
      (j.revisions || []).forEach(function (r) {
        var li = el('li', { text: 'Revision ' + r.revision + ' · ' + r.status + ' · ' + String(r.saved_at).slice(0, 16).replace('T', ' ') + ' · ' + r.saved_by + (r.note ? ' · ' + r.note : '') + ' ' });
        if (r.revision !== current.revision) {
          var b = el('button', { type: 'button', text: 'Restore' });
          b.addEventListener('click', function () {
            api('POST', '/api/content/restore', { path: current.path, revision: r.revision }).then(function (res) {
              if (res._status !== 200) return errors(res);
              edit(current.path).then(list);
            });
          });
          li.appendChild(b);
        }
        ul.appendChild(li);
      });
    });
  }

  $('content-save').addEventListener('click', function () {
    if (!current) return;
    text($('content-saved'), 'Saving and rebuilding…');
    api('PUT', '/api/content/item', { path: current.path, base_revision: current.revision, body: $('content-body').value,
      status: $('content-status').value, note: $('content-note').value || undefined }).then(function (j) {
      if (j._status !== 200) { text($('content-saved'), ''); return errors(j); }
      text($('content-errors'), '');
      text($('content-saved'), 'Saved. Version ' + j.version + ' is live.');
      $('content-note').value = '';
      edit(current.path).then(list);
    });
  });

  $('content-preview').addEventListener('click', function () {
    if (!current) return;
    api('POST', '/api/content/preview', { path: current.path, body: $('content-body').value, status: $('content-status').value }).then(function (j) {
      if (j._status !== 200) return errors(j);
      text($('content-errors'), '');
      var f = $('content-frame');
      f.hidden = false;
      f.srcdoc = j.html;
    });
  });

  $('content-new').addEventListener('click', function () {
    var p = ($('content-new-path').value || '').trim();
    if (p) edit(p);
  });

  $('content-import').addEventListener('click', function () {
    api('POST', '/api/content/import').then(function (j) { if (j._status !== 200) errors(j); list(); });
  });

  list();
})();
