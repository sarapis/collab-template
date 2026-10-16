/* collab widget -- the embeddable half.
 *
 * Drops into any page that contains elements the compiler emitted. It adds
 * answers and the answer form to questions that are already in the HTML, and
 * fills the badge. It never renders the question itself: the question is
 * content and ships in the document.
 *
 * ⚠️ STRICTLY ADDITIVE. Every failure path is a silent return. A document that
 * will not display because an answers endpoint is down is a bad trade, and a
 * document that shows no open questions because a fetch failed is worse than
 * that -- it reads as settled.
 */
(function () {
  'use strict';

  var meta = document.querySelector('meta[name="collab-api"]');
  var API = (meta && meta.content) || '';
  var me = null;

  function api(path, opts) {
    return fetch(API + path, Object.assign({ credentials: 'include' }, opts || {}))
      .then(function (r) {
        if (r.ok) return r.json();
        // ⚠️ Carry the server's REASON, not just the status. A write can be
        // refused for something the person can fix in five seconds -- a body
        // over the length limit is the case this was added for -- and a button
        // that only says "Not posted" makes them retype the same thing and
        // watch it fail again. Falls back to the status when the body is not
        // JSON, so this stays a rejection either way.
        // ⚠️ Still a Promise.reject and not a throw: the widget never throws
        // into the page it is decorating, which is what the gate checks for.
        // The only thing that changed is what the rejection CARRIES.
        return r.json().catch(function () { return null; }).then(function (j) {
          return Promise.reject(new Error((j && j.error) || String(r.status)));
        });
      });
  }

  // The reason, when the server gave one worth reading. A bare status code is
  // not an explanation, so it becomes the generic line instead.
  function why(err, fallback) {
    var m = err && err.message;
    return m && !/^\d+$/.test(m) ? m : fallback;
  }

  // One place for a form to say what went wrong, cleared on the next attempt.
  function msgNode() { return el('p', 'q-msg'); }
  function say(node, text) { if (node) node.textContent = text || ''; }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function when(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toISOString().slice(0, 10);
  }

  function renderAnswer(a) {
    var box = el('div', 'q-answer');
    var who = el('p', 'who');
    who.textContent = (a.author_name || 'someone') + ' · ' + when(a.created_at);
    if (a.revision_count > 0) {
      // A silent rewrite could leave a passage resting on text that no longer
      // justifies it, so an edit is always visible to every reader.
      var ed = el('span', 'q-edited', ' · edited ' + a.revision_count + '×');
      who.appendChild(ed);
    }
    var body = el('div', 'q-answer-body');
    body.textContent = a.body;
    box.appendChild(who);
    box.appendChild(body);
    if (a.mine) box.appendChild(editButton(a, body));
    return box;
  }

  function editButton(a, bodyNode) {
    var b = el('button', 'btn', 'Edit');
    b.type = 'button';
    b.addEventListener('click', function () {
      var ta = el('textarea');
      ta.value = a.body;
      var save = el('button', 'btn', 'Save');
      var msg = msgNode();
      save.type = 'button';
      save.addEventListener('click', function () {
        say(msg, '');
        api('/api/answers/' + encodeURIComponent(a.id), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ body: ta.value }),
        }).then(function () { load(); }).catch(function (err) {
          // ⚠️ The text stays in the box. A refused edit that also cleared
          // the textarea would lose the words it refused to store.
          say(msg, why(err, 'Not saved. Try again.'));
        });
      });
      bodyNode.replaceChildren(ta, save, msg);
    });
    return b;
  }

  function renderForm(qid, mount) {
    if (!me || !me.authenticated || !me.can_write) return;
    var form = el('div', 'q-form');
    var ta = el('textarea');
    ta.rows = 3;
    ta.placeholder = 'Answer this';
    var btn = el('button', 'btn', 'Post answer');
    var msg = msgNode();
    btn.type = 'button';
    btn.addEventListener('click', function () {
      var body = ta.value.trim();
      if (!body) return;
      btn.disabled = true;
      say(msg, '');
      api('/api/answers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question_id: qid, body: body }),
      }).then(function () { ta.value = ''; btn.disabled = false; load(); })
        .catch(function (err) { btn.disabled = false; say(msg, why(err, 'Not posted. Try again.')); });
    });
    form.appendChild(ta);
    form.appendChild(btn);
    form.appendChild(msg);
    mount.appendChild(form);
  }

  // --- filtering the worksheet ---------------------------------------------
  //
  // "Answered" is live data, so this can only run once the answers have loaded.
  // Until then every question is shown, which is the right way round: a reader
  // who arrives before the fetch sees everything rather than an empty page.
  //
  // ⚠️ An answer written before its question's current round does not count.
  // A question reworded after somebody answered it is unanswered again, and the
  // filter has to agree with the notification that sent them here.
  function currentAnswerCount(card) {
    var mount = card.querySelector('[data-answers-for]');
    if (!mount) return 0;
    // Answers marked stale replied to an earlier wording of the question, and
    // renderAnswer has already labelled them. They do not make it answered.
    return Array.prototype.slice.call(mount.querySelectorAll('.q-answer'))
      .filter(function (a) { return !a.classList.contains('q-answer-stale'); }).length;
  }

  function currentFilter() {
    var p = new URLSearchParams(location.search);
    if (p.get('show')) return p.get('show');
    // ?open=1 is linked from the notification and written into the README, so
    // it keeps working and means what the notification means.
    if (p.get('open')) return 'waiting';
    return 'all';
  }

  function applyFilter(show) {
    var cards = Array.prototype.slice.call(document.querySelectorAll('.cards .card[data-question]'));
    if (!cards.length) return;
    var shown = 0;

    cards.forEach(function (card) {
      var answers = currentAnswerCount(card);
      var resolved = card.getAttribute('data-resolved') === 'true';
      // Who it waits on: `to=` when the question has it, else its audience (worker/src/waits.js).
      var waits = (card.getAttribute('data-waits-on') || card.getAttribute('data-audience') || '').split(' ');
      var forMe = !!(me && me.audiences && waits.some(function (g) { return me.audiences.indexOf(g) !== -1; }));
      var keep = true;
      if (show === 'waiting') keep = forMe && !answers && !resolved;
      else if (show === 'unanswered') keep = !answers && !resolved;
      else if (show === 'answered') keep = answers > 0 && !resolved;
      card.hidden = !keep;
      if (keep) shown++;
    });

    // A group heading with nothing under it reads as an empty category rather
    // than a hidden one.
    Array.prototype.slice.call(document.querySelectorAll('.cards')).forEach(function (group) {
      var any = Array.prototype.slice.call(group.querySelectorAll('.card[data-question]'))
        .some(function (c) { return !c.hidden; });
      group.hidden = !any;
      var heading = group.previousElementSibling;
      if (heading && heading.tagName === 'H2') heading.hidden = !any;
    });

    Array.prototype.slice.call(document.querySelectorAll('#q-filters .filter')).forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-show') === show));
    });

    var note = document.getElementById('q-filter-note');
    if (note) {
      note.textContent = show === 'all' ? ''
        : shown + ' of ' + cards.length + ' shown' + (shown ? '' : ' — nothing matches this filter');
    }
  }

  function wireFilters() {
    var bar = document.getElementById('q-filters');
    if (!bar) return;
    bar.addEventListener('click', function (e) {
      var btn = e.target.closest('.filter');
      if (!btn) return;
      var show = btn.getAttribute('data-show');
      var url = new URL(location.href);
      url.searchParams.delete('open');
      if (show === 'all') url.searchParams.delete('show');
      else url.searchParams.set('show', show);
      history.replaceState(null, '', url);
      applyFilter(show);
    });
  }

  function mounts() {
    return Array.prototype.slice.call(document.querySelectorAll('[data-answers-for]'));
  }

  function load() {
    var nodes = mounts();
    if (!nodes.length) return Promise.resolve();
    var ids = nodes.map(function (n) { return n.getAttribute('data-answers-for'); });
    return api('/api/answers?q=' + encodeURIComponent(ids.join(','))).then(function (data) {
      nodes.forEach(function (n) {
        var qid = n.getAttribute('data-answers-for');
        var list = (data.answers && data.answers[qid]) || [];
        var opened = n.getAttribute('data-round-opened');
        n.replaceChildren();
        list.forEach(function (a) {
          var box = renderAnswer(a);
          // ⚠️ An answer written before this round was an answer to an earlier
          // wording. Say so on the answer rather than leaving somebody to work
          // out why a question they answered is being asked again.
          if (opened && a.created_at && a.created_at < opened) {
            box.classList.add('q-answer-stale');
            box.insertBefore(el('p', 'q-stale-note', 'This answered an earlier version of the question.'), box.firstChild);
          }
          n.appendChild(box);
        });
        renderForm(qid, n);
      });
      applyFilter(currentFilter());
      applyHash();
    });
  }

  // Notifications is a permanent item, not a pill that appears and vanishes. It
  // reads as ordinary until there is something in it, then carries the count.
  // Notifications is a permanent item, not a pill that appears and vanishes. It
  // reads as ordinary until there is something in it, then carries the count.
  //
  // ⚠️ The badge carries `total`, which counts only what is UNSEEN. The feed
  // below carries each item's `count`, which is what is outstanding. They
  // disagree on purpose: ten answers still waiting to be folded in is true and
  // worth showing, and it is not ten pieces of news every time you open the
  // page.
  function notifications() {
    var node = document.getElementById('collab-badge');
    var feed = document.getElementById('notice-feed');
    if (!node && !feed) return Promise.resolve();

    return api('/api/notifications').then(function (data) {
      var items = data.items || [];

      if (node) {
        node.replaceChildren(document.createTextNode('Notifications'));
        node.classList.toggle('has-news', data.total > 0);
        if (data.total) {
          node.appendChild(el('span', 'count', String(data.total)));
          node.title = items.filter(function (i) { return i.unseen > 0; })
            .map(function (i) { return i.text; }).join(' \u00b7 ');
        }
      }

      if (!feed) return;
      feed.replaceChildren();
      if (!items.length) {
        feed.appendChild(el('p', 'muted', 'Nothing is waiting, and nothing has happened since you last looked.'));
      }
      items.forEach(function (item) {
        var card = el('article', 'card ' + (item.forYou ? 'open' : 'resolved') + (item.unseen > 0 ? ' is-new' : ''));
        var head = el('p');
        var link = document.createElement('a');
        link.href = item.href;
        link.textContent = item.text;
        head.appendChild(link);
        if (item.unseen > 0) head.appendChild(el('span', 'is-new-flag', 'new'));
        card.appendChild(head);
        if (item.detail) card.appendChild(el('p', 'counts', item.detail));
        feed.appendChild(card);
      });

      // Visiting the feed is what "I have looked" means. \u26a0\ufe0f Only here --
      // marking things seen from any page would clear a count nobody read.
      return api('/api/seen', { method: 'POST' }).then(function () {
        var note = document.getElementById('notice-seen');
        if (note) note.textContent = 'Everything above is marked as seen from this visit onward, so the badge clears. The counts do not \u2014 what is outstanding stays on this page and on the worksheet until it is actually dealt with.';
      }).catch(function () {});
    });
  }

  // ⚠️ A hash deep link does not survive a cold load if the target moved after
  // the browser handled the hash -- which it does here, because answers are
  // appended above it. Re-apply after render. Testing this by setting
  // location.hash from the console re-triggers the handler and HIDES the bug;
  // only a genuine cold navigation shows it.
  function applyHash() {
    if (!location.hash) return;
    var t = document.getElementById(location.hash.slice(1));
    if (t) t.scrollIntoView({ block: 'start' });
  }

  // --- the rail -----------------------------------------------------------
  // Tab switching is pure DOM and works with no network at all. Only the
  // comments themselves need the API, and their absence is stated rather than
  // left as an empty panel.
  // Remembering whether the rail is open is a per-viewer convenience, so it
  // belongs in localStorage -- and every access is wrapped, because a private
  // window or blocked site data makes these throw rather than return nothing.
  function railPref(value) {
    try {
      if (value === undefined) return localStorage.getItem('collab-rail');
      localStorage.setItem('collab-rail', value);
    } catch (e) { /* the page must work without it */ }
    return null;
  }

  // --- referenced passages -------------------------------------------------
  // A question cites the passage it depends on. On the worksheet that passage is
  // shown in place: navigating away costs you the half-typed answer, and on a
  // phone it costs you your place entirely.
  var sections = null;

  function wireSeeLinks() {
    var links = Array.prototype.slice.call(document.querySelectorAll('a[data-see-section]'));
    if (!links.length) return;
    // In a document the reader is already there, so a link is the right thing.
    // Only the worksheet expands.
    if (!document.getElementById('q-counts')) return;

    links.forEach(function (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        var key = link.getAttribute('data-see-section');
        var card = link.closest('.card') || link.parentNode;
        var open = card.querySelector('.q-context[data-for="' + key + '"]');
        if (open) { open.remove(); link.classList.remove('open'); return; }

        var box = el('div', 'q-context');
        box.setAttribute('data-for', key);
        box.appendChild(el('p', 'muted', 'Loading…'));
        card.appendChild(box);
        link.classList.add('open');

        var show = function () {
          var html = sections && sections[key];
          if (!html) {
            // ⚠️ Not silence. The reference resolved at build time, so if it is
            // missing here something else is wrong and the reader should be
            // sent to the page rather than left with an empty box.
            box.replaceChildren(el('p', 'muted', 'That passage could not be loaded. '));
            var a = document.createElement('a');
            a.href = link.href;
            a.textContent = 'Open it instead';
            box.firstChild.appendChild(a);
            return;
          }
          box.innerHTML = html;
          var out = document.createElement('a');
          out.className = 'q-context-out';
          out.href = link.href;
          out.textContent = 'Open in the document \u2192';
          box.appendChild(out);
        };

        if (sections) { show(); return; }
        api('/sections.json').then(function (data) { sections = data; show(); })
          .catch(function () { sections = {}; show(); });
      });
    });
  }

  function wireRailSwitch() {
    var btn = document.getElementById('rail-switch');
    if (!btn) return;
    var root = document.documentElement;

    function apply(state) {
      var closed = state === 'closed';
      root.setAttribute('data-rail', closed ? 'closed' : 'open');
      btn.textContent = closed ? 'Show contents' : 'Hide contents';
      btn.setAttribute('aria-expanded', String(!closed));
    }

    apply(railPref() === 'closed' ? 'closed' : 'open');
    btn.addEventListener('click', function () {
      var next = root.getAttribute('data-rail') === 'closed' ? 'open' : 'closed';
      apply(next);
      railPref(next);
    });
  }

  function wireRail() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll('.rail-tab'));
    if (!tabs.length) return;
    var panels = { contents: document.getElementById('rail-contents'), comments: document.getElementById('rail-comments') };
    tabs.forEach(function (t) {
      t.addEventListener('click', function () {
        var want = t.getAttribute('data-rail');
        tabs.forEach(function (o) { o.setAttribute('aria-selected', String(o === t)); });
        Object.keys(panels).forEach(function (k) { if (panels[k]) panels[k].hidden = k !== want; });
      });
    });
  }

  function docSlug() {
    var m = document.querySelector('meta[name="collab-doc"]');
    return (m && m.content) || '';
  }

  function sectionsOnPage() {
    return Array.prototype.slice.call(document.querySelectorAll('main h2[id]'))
      .map(function (h) { return { id: h.id, text: h.textContent.trim() }; });
  }

  function commentBlock(c, label) {
    var box = el('div', 'q-answer');
    var who = el('p', 'who');
    who.textContent = (c.author_name || 'someone') + ' · ' + when(c.created_at) + (label ? ' · ' + label : '');
    var body = el('div', 'q-answer-body');
    body.textContent = c.body;
    box.appendChild(who);
    box.appendChild(body);
    return box;
  }

  function commentForm(mount, slug, sections) {
    if (!me || !me.authenticated || !me.can_write) return;
    var form = el('div', 'q-form');
    var pick = document.createElement('select');
    var whole = document.createElement('option');
    whole.value = '';
    whole.textContent = 'The whole document';
    pick.appendChild(whole);
    sections.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.text;
      pick.appendChild(o);
    });
    var ta = el('textarea');
    ta.rows = 3;
    ta.placeholder = 'Tell the team something';
    var btn = el('button', 'btn', 'Post comment');
    var msg = msgNode();
    btn.type = 'button';
    btn.addEventListener('click', function () {
      var body = ta.value.trim();
      if (!body) return;
      btn.disabled = true;
      say(msg, '');
      api('/api/comments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: body, doc: slug || null, section: pick.value || null }),
      }).then(function () { ta.value = ''; btn.disabled = false; comments(); })
        .catch(function (err) { btn.disabled = false; say(msg, why(err, 'Not posted. Try again.')); });
    });
    form.appendChild(pick);
    form.appendChild(ta);
    form.appendChild(btn);
    form.appendChild(msg);
    mount.appendChild(form);
  }

  function comments() {
    var mount = document.getElementById('rail-comments');
    if (!mount) return Promise.resolve();
    var slug = docSlug();
    var sections = sectionsOnPage();
    var known = {};
    sections.forEach(function (s) { known[s.id] = s.text; });

    return api('/api/comments' + (slug ? '?doc=' + encodeURIComponent(slug) : '')).then(function (data) {
      var list = data.comments || [];
      mount.replaceChildren();
      if (!list.length) mount.appendChild(el('p', 'muted', 'No comments yet.'));
      list.forEach(function (c) {
        var label;
        if (!c.section) label = c.doc ? 'this document' : 'the project';
        else if (known[c.section]) label = known[c.section];
        // ⚠️ A comment whose section has been renamed away must not vanish.
        // It falls back to the document and says so, because a comment that
        // disappears silently is worse than one pointing at a stale anchor.
        else label = 'a section that no longer exists';
        mount.appendChild(commentBlock(c, label));
      });
      commentForm(mount, slug, sections);
    }).catch(function () {
      mount.replaceChildren(el('p', 'muted', 'Comments are unavailable right now.'));
    });
  }

  // --- admin ----------------------------------------------------------------
  // ⚠️ Revealing the section is presentation. Every admin route refuses a
  // non-admin on the server; hiding a link is not access control and must never
  // be the only thing standing between somebody and a page.
  function revealAdmin() {
    var isAdmin = me && me.role === 'admin';
    ['menu-admin', 'admin-only', 'admin-people', 'admin-settings'].forEach(function (id) {
      var n = document.getElementById(id);
      if (n) n.hidden = !isAdmin;
    });
    ['admin-denied', 'people-denied', 'settings-denied'].forEach(function (id) {
      var n = document.getElementById(id);
      if (n) n.hidden = !!isAdmin;
    });
    // ⚠️ Driven from HERE, not from the boot sequence. loadSecrets() was in the
    // Promise.all at startup, which runs for everybody: a non-admin got a
    // silent 403 and an admin got rows only by luck of ordering. Whatever
    // reveals the section is what should fill it.
    if (isAdmin) { loadPeople(); loadMembershipLog(); loadSecrets(); }
  }

  function roleSelect(person, onChange) {
    var sel = document.createElement('select');
    [['user', 'User'], ['contributor', 'Contributor'], ['admin', 'Admin']].forEach(function (pair) {
      var o = document.createElement('option');
      o.value = pair[0]; o.textContent = pair[1];
      if (person.role === pair[0]) o.selected = true;
      sel.appendChild(o);
    });
    sel.disabled = !!person.root;
    sel.addEventListener('change', function () { onChange(sel.value); });
    return sel;
  }

  // The groups a person answers for, as checkboxes from the site's own list
  // (site.config.yml `audiences`). `groups` is null when the server could not
  // read that list: then it is the old comma-separated box rather than nothing,
  // so the roster can still be edited. A group the person has that the site no
  // longer defines stays visible, ticked and marked, so it can be removed.
  function groupPicker(idBase, selected, groups, onChange) {
    if (!groups) {
      var input = document.createElement('input');
      input.value = selected.join(', ');
      input.size = 12;
      input.setAttribute('aria-label', 'Groups, comma separated');
      if (onChange) input.addEventListener('change', function () {
        onChange(input.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean));
      });
      input.groupValue = function () { return input.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean); };
      return input;
    }
    var box = el('div', 'group-picker', '');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Groups');
    var known = groups.map(function (g) { return g.id; });
    var options = groups.map(function (g) { return { id: g.id, name: g.name, describes: g.describes, gone: false }; });
    selected.forEach(function (id) {
      if (known.indexOf(id) === -1) options.push({ id: id, name: id, describes: 'Not a group on this site any more', gone: true });
    });
    if (!options.length) { box.appendChild(el('span', 'muted', 'This site defines no groups')); }
    var boxes = [];
    options.forEach(function (g, i) {
      var label = document.createElement('label');
      label.className = 'group-option' + (g.gone ? ' gone' : '');
      if (g.describes) label.title = g.describes;
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = g.id;
      cb.id = idBase + '-' + i;
      cb.checked = selected.indexOf(g.id) !== -1;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + g.name));
      box.appendChild(label);
      boxes.push(cb);
    });
    box.groupValue = function () {
      return boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
    };
    if (onChange) boxes.forEach(function (cb) {
      cb.addEventListener('change', function () {
        boxes.forEach(function (b) { b.disabled = true; });
        // A refused change puts the boxes back as the server has them, rather
        // than leaving a tick on the page that was never saved.
        Promise.resolve(onChange(box.groupValue())).catch(function () { cb.checked = !cb.checked; })
          .then(function () { boxes.forEach(function (b) { b.disabled = false; }); });
      });
    });
    return box;
  }

  function renderAddGroups(groups) {
    var mount = document.getElementById('p-groups');
    if (!mount) return;
    mount.replaceChildren(groupPicker('p-group', [], groups, null));
  }

  function patchPerson(email, body) {
    return api('/api/admin/people/' + encodeURIComponent(email), {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  }

  // ⚠️ Shown only when there is something to show. The section is hidden by
  // default, so a site where this never happens never grows a permanent warning
  // nobody reads.
  function renderOrphans(list) {
    var section = document.getElementById('orphan-identities');
    var mount = document.getElementById('orphan-rows');
    if (!section || !mount) return;
    section.hidden = !list.length;
    mount.replaceChildren();
    list.forEach(function (o) {
      var li = document.createElement('li');
      li.textContent = o.count + ' in ' + o.store + ' written as ';
      li.appendChild(el('code', '', o.who));
      mount.appendChild(li);
    });
  }

  // ⚠️ The form is write-only. It never receives a value and never renders one:
  // the API does not return them at all, so there is nothing here to leak even
  // if this code were wrong.
  function loadSecrets() {
    var rows = document.getElementById('settings-rows');
    if (!rows) return;
    api('/api/admin/secrets').then(function (data) {
      var warn = document.getElementById('settings-unavailable');
      if (warn) {
        warn.hidden = !!data.configurable;
        warn.textContent = data.configurable ? ''
          : 'This instance has no SETTINGS_KEY, so a value cannot be stored safely. Set one with `wrangler secret put SETTINGS_KEY` and reload.';
      }
      rows.replaceChildren();
      (data.secrets || []).forEach(function (sec) {
        var tr = document.createElement('tr');

        var name = document.createElement('td');
        name.appendChild(el('code', '', sec.name));
        tr.appendChild(name);

        var what = document.createElement('td');
        what.textContent = sec.describes;
        tr.appendChild(what);

        var state = document.createElement('td');
        if (sec.source === 'stored') {
          state.textContent = 'set here';
          state.appendChild(el('span', 'tag', (sec.set_by || '') + ' · ' + String(sec.set_at || '').slice(0, 10)));
        } else if (sec.source === 'deploy') {
          state.appendChild(el('span', 'tag', 'set at deploy'));
        } else {
          state.textContent = 'not set';
        }
        tr.appendChild(state);

        var actions = document.createElement('td');
        var input = document.createElement('input');
        // ⚠️ A masked field is for a value you cannot be shown back. Masking an
        // address or a Google client id — which is in every visitor's OAuth
        // redirect anyway — teaches people that the asterisks mean nothing.
        input.type = sec.public ? 'text' : 'password';
        input.size = sec.public ? 26 : 14;
        input.autocomplete = 'off';
        if (sec.public) {
          input.value = sec.value || '';
          input.placeholder = 'not set';
        } else {
          input.placeholder = sec.source === 'none' ? 'paste value' : 'replace';
        }
        actions.appendChild(input);

        var save = el('button', 'btn small', 'Save');
        save.type = 'button';
        save.addEventListener('click', function () {
          if (!input.value.trim()) return;
          if (sec.public && input.value === (sec.value || '')) return;
          api('/api/admin/secrets/' + encodeURIComponent(sec.name), {
            method: 'PUT', body: JSON.stringify({ value: input.value }),
          }).then(function () { input.value = ''; loadSecrets(); loadMembershipLog(); })
            .catch(function () { loadSecrets(); });
        });
        actions.appendChild(save);

        if (sec.source === 'stored') {
          var clear = el('button', 'btn small', 'Clear');
          clear.type = 'button';
          clear.addEventListener('click', function () {
            api('/api/admin/secrets/' + encodeURIComponent(sec.name), { method: 'DELETE' })
              .then(function () { loadSecrets(); loadMembershipLog(); })
              .catch(function () { loadSecrets(); });
          });
          actions.appendChild(clear);
        }
        tr.appendChild(actions);
        rows.appendChild(tr);
      });
    }).catch(function () {});
  }

  function loadPeople() {
    var rows = document.getElementById('people-rows');
    if (!rows) return;
    api('/api/admin/people').then(function (data) {
      renderOrphans(data.orphans || []);
      renderAddGroups(data.groups);
      rows.replaceChildren();
      (data.people || []).forEach(function (p) {
        var tr = document.createElement('tr');
        if (p.disabled) tr.className = 'disabled';

        var name = document.createElement('td');
        name.textContent = p.name;
        if (p.root) name.appendChild(el('span', 'tag', 'deployed with'));
        tr.appendChild(name);

        var email = document.createElement('td');
        email.textContent = p.email;
        tr.appendChild(email);

        var role = document.createElement('td');
        role.appendChild(roleSelect(p, function (next) {
          patchPerson(p.email, { role: next }).then(loadPeople).then(loadMembershipLog)
            .catch(function () { loadPeople(); });
        }));
        tr.appendChild(role);

        var aud = document.createElement('td');
        aud.appendChild(groupPicker('g-' + p.email, p.audiences || [], data.groups, function (list) {
          return patchPerson(p.email, { audiences: list }).then(loadMembershipLog);
        }));
        tr.appendChild(aud);

        var actions = document.createElement('td');
        if (!p.root && !p.implicit) {
          // ⚠️ Disable, not delete, as the ordinary action. Removing somebody
          // does not remove what they wrote, and their name stays on it.
          var toggle = el('button', 'btn small', p.disabled ? 'Restore' : 'Disable');
          toggle.type = 'button';
          toggle.addEventListener('click', function () {
            patchPerson(p.email, { disabled: !p.disabled }).then(loadPeople).then(loadMembershipLog);
          });
          actions.appendChild(toggle);
        }
        tr.appendChild(actions);
        rows.appendChild(tr);
      });
    }).catch(function () {
      rows.replaceChildren(el('tr', '', ''));
    });
  }

  function loadMembershipLog() {
    var mount = document.getElementById('membership-log');
    if (!mount) return;
    return api('/api/admin/log').then(function (data) {
      mount.replaceChildren();
      var entries = data.entries || [];
      if (!entries.length) { mount.appendChild(el('p', 'muted', 'Nothing has changed yet.')); return; }
      entries.forEach(function (e) {
        var card = el('article', 'card');
        card.appendChild(el('p', 'counts', when(e.at) + ' · ' + e.actor));
        card.appendChild(el('p', '', e.action.replace(/_/g, ' ') + ' — ' + e.subject + (e.detail ? ' (' + e.detail + ')' : '')));
        mount.appendChild(card);
      });
    });
  }

  function wireAddPerson() {
    var form = document.getElementById('add-person');
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var note = document.getElementById('add-note');
      var body = {
        name: form.querySelector('#p-name').value.trim(),
        email: form.querySelector('#p-email').value.trim(),
        role: form.querySelector('#p-role').value,
        audiences: (function () { var g = document.getElementById('p-groups').firstChild; return g && g.groupValue ? g.groupValue() : []; })(),
      };
      api('/api/admin/people', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }).then(function () {
        form.reset();
        if (note) note.textContent = body.name + ' can sign in now. Tell them the address to use.';
        loadPeople(); loadMembershipLog();
      }).catch(function (err) {
        // The server's reason, not a generic failure: "already on the roster"
        // and "that is not an email" need different actions from the person.
        if (note) note.textContent = 'That did not work. Check the address is valid and not already on the list.';
        void err;
      });
    });
  }

  function showUser() {
    var name = document.getElementById('collab-user');
    var out = document.getElementById('collab-signout');
    if (!name) return;
    if (me && me.authenticated) {
      name.textContent = me.name || me.email || 'Signed in';
      if (out) out.hidden = false;
    } else {
      name.textContent = 'Not signed in';
    }
  }

  function start() {
    api('/api/me')
      .then(function (u) { me = u; })
      .catch(function () { me = null; })
      .then(function () { showUser(); revealAdmin(); return Promise.all([load(), notifications(), comments(), wireChatLog()]); })
      .catch(function () { /* silence is the contract */ });
  }

  // --- the assistant ------------------------------------------------------
  var chatSession = null;

  function turn(role, text) {
    var box = el('div', 'chat-turn' + (role === 'you' ? ' you' : ''));
    box.appendChild(el('p', 'who', role === 'you' ? 'You' : 'Assistant'));
    box.appendChild(el('div', 'body', text));
    return box;
  }

  function wireChat() {
    var panel = document.getElementById('chat-panel');
    var openBtn = document.getElementById('chat-open');
    var closeBtn = document.getElementById('chat-close');
    var thread = document.getElementById('chat-thread');
    var input = document.getElementById('chat-input');
    var send = document.getElementById('chat-send');
    if (!panel || !openBtn || !thread || !input || !send) return;

    // The conversation survives moving between pages in this tab, which is the
    // point of the overlay: you ask about one document, read another, and carry
    // on. ⚠️ sessionStorage rather than localStorage -- a conversation is about
    // this visit, and it is stored server-side anyway.
    function remembered(key, value) {
      try {
        if (value === undefined) return sessionStorage.getItem(key);
        sessionStorage.setItem(key, value);
      } catch (e) { /* the page must work without it */ }
      return null;
    }

    chatSession = remembered('collab-chat-session') || null;

    function setOpen(open) {
      panel.hidden = !open;
      openBtn.setAttribute('aria-expanded', String(open));
      openBtn.hidden = open;
      if (open) { input.focus(); thread.scrollTop = thread.scrollHeight; }
    }

    openBtn.addEventListener('click', function () { setOpen(true); restore(); });
    if (closeBtn) closeBtn.addEventListener('click', function () { setOpen(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !panel.hidden) setOpen(false);
    });

    var restored = false;
    function restore() {
      if (restored || !chatSession) return;
      restored = true;
      api('/api/chat/sessions/' + encodeURIComponent(chatSession)).then(function (d) {
        (d.turns || []).forEach(function (t) {
          thread.appendChild(turn('you', t.user_message));
          if (t.assistant_message) thread.appendChild(turn('assistant', t.assistant_message));
        });
        thread.scrollTop = thread.scrollHeight;
      }).catch(function () { /* a conversation that cannot be restored is not an error */ });
    }

    function ask() {
      var text = input.value.trim();
      if (!text) return;
      thread.appendChild(turn('you', text));
      input.value = '';
      send.disabled = true;
      var pending = turn('assistant', 'Thinking\u2026');
      thread.appendChild(pending);
      thread.scrollTop = thread.scrollHeight;
      api('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text, session_id: chatSession }),
      }).then(function (r) {
        chatSession = r.session_id || chatSession;
        if (chatSession) remembered('collab-chat-session', chatSession);
        pending.replaceChildren(el('p', 'who', 'Assistant'), el('div', 'body', r.answer || ''));
        send.disabled = false;
        thread.scrollTop = thread.scrollHeight;
      }).catch(function () {
        pending.replaceChildren(el('p', 'who', 'Assistant'),
          el('div', 'body', 'That did not work. Your question was recorded and the team can see it.'));
        send.disabled = false;
      });
    }

    send.addEventListener('click', ask);
    input.addEventListener('keydown', function (e) {
      // Enter sends, shift+enter is a newline -- the convention people already
      // have in every other chat box.
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); }
    });
  }

  function wireChatLog() {
    var mount = document.getElementById('chat-sessions');
    if (!mount) return;
    // ⚠️ An empty container is the failure mode this project keeps finding in
    // other people's sites: the API refuses, nothing renders, and the page
    // reads as broken rather than as not-for-you.
    var denied = document.getElementById('log-denied');
    api('/api/chat/sessions').then(function (r) {
      var list = r.sessions || [];
      mount.replaceChildren();
      if (!list.length) { mount.appendChild(el('p', 'muted', 'Nobody has asked anything yet.')); return; }
      list.forEach(function (s) {
        var card = el('article', 'card chat-session');
        card.appendChild(el('p', 'counts', (s.author_name || 'someone') + ' \u00b7 ' + s.turns + ' turn(s) \u00b7 ' + when(s.last)));
        var body = el('div');
        card.appendChild(body);
        card.addEventListener('click', function () {
          if (body.childNodes.length) { body.replaceChildren(); return; }
          api('/api/chat/sessions/' + encodeURIComponent(s.session_id)).then(function (d) {
            (d.turns || []).forEach(function (t) {
              body.appendChild(turn('you', t.user_message));
              body.appendChild(turn('assistant', t.assistant_message || ('[no answer: ' + (t.error || 'unknown') + ']')));
            });
          });
        });
        mount.appendChild(card);
      });
    }).catch(function () {
      // ⚠️ "Unavailable right now" is what a contributor sees when the server is
      // down and ALSO what a stranger saw when it refused them — one message
      // for two different facts, and the wrong one for the common case.
      mount.replaceChildren();
      if (denied) denied.hidden = false;
      else mount.appendChild(el('p', 'muted', 'The log is unavailable right now.'));
    });
  }

  // Header dropdowns (band layout, project.header_menus). They work with no
  // script as <details>; this only keeps one open at a time and closes them on
  // Escape or a click anywhere else.
  function wireNavMenus() {
    var groups = document.querySelectorAll('details.nav-group');
    if (!groups.length) return;
    function closeAll(except) {
      for (var i = 0; i < groups.length; i++) if (groups[i] !== except) groups[i].open = false;
    }
    for (var i = 0; i < groups.length; i++) {
      groups[i].addEventListener('toggle', function (e) { if (e.target.open) closeAll(e.target); });
    }
    document.addEventListener('click', function (e) {
      if (!e.target || !e.target.closest || !e.target.closest('details.nav-group')) closeAll(null);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAll(null); });
  }

  function boot() { wireRailSwitch(); wireRail(); wireNavMenus(); wireChat(); wireSeeLinks(); wireFilters(); wireAddPerson(); start(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
