/* DROP ZONE slice — playtest feedback: threaded comments, in the page.
 * Steve's call, 2026-10-30: "Add a comments button. Feedback. Threaded."
 * Steve and Nic leave playtest notes here while playing; threads keep a
 * note and its replies together.
 *
 * DATA MODEL (backend-ready): comments are ONE flat, serializable list —
 *   { id: string, parentId: string | null, author: string,
 *     text: string, timestamp: number (ms since epoch) }
 * Threading is derived at render time from parentId; it is never stored
 * nested. Today the list persists to localStorage ('dropzone-feedback-v1')
 * and the handle to 'dropzone-feedback-author'. When the slice gets a
 * hosted backend, replace loadList()/persistList() with fetch() calls
 * against the shared store and nothing else in this file changes — the
 * model above is already the wire format.
 *
 * Feedback is playtest tooling, NOT game state: it never touches core.js,
 * the save document, or SAVE_VERSION. Until hosting lands, comments live
 * in each player's own browser; Copy / Download in the panel pull them out.
 */
(function () {
  'use strict';

  var STORE_KEY = 'dropzone-feedback-v1';
  var AUTHOR_KEY = 'dropzone-feedback-author';
  var MAX_DEPTH_INDENT = 4; // visual indent cap; the data nests without limit
  var root = typeof window !== 'undefined' ? window
    : (typeof globalThis !== 'undefined' ? globalThis : this);

  /* ---- storage: the ONLY layer a hosted backend replaces ---- */
  var memoryAuthor = '';
  var comments = loadList();

  function storage() {
    try { return root.localStorage || null; } catch (e) { return null; }
  }
  function loadList() {
    var ls = storage();
    if (ls) {
      try {
        var raw = ls.getItem(STORE_KEY);
        if (raw) {
          var parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.comments)) {
            return parsed.comments.filter(function (c) {
              return c && typeof c.id === 'string' && typeof c.text === 'string' &&
                typeof c.timestamp === 'number';
            });
          }
        }
      } catch (e) { /* corrupted store — start empty rather than crash */ }
    }
    return [];
  }
  function persistList() {
    var ls = storage();
    if (ls) {
      try { ls.setItem(STORE_KEY, JSON.stringify({ version: 1, comments: comments })); }
      catch (e) { /* storage full/blocked — the in-memory list still works this session */ }
    }
  }
  function getAuthor() {
    if (memoryAuthor) return memoryAuthor;
    var ls = storage();
    if (ls) { try { memoryAuthor = ls.getItem(AUTHOR_KEY) || ''; } catch (e) { /* ignore */ } }
    return memoryAuthor;
  }
  function setAuthor(name) {
    memoryAuthor = String(name || '');
    var ls = storage();
    if (ls) { try { ls.setItem(AUTHOR_KEY, memoryAuthor); } catch (e) { /* ignore */ } }
  }

  /* ---- data operations (pure — no DOM below this line until render) ---- */
  var idCounter = 0;
  function newId() {
    idCounter += 1;
    return 'c' + Date.now().toString(36) + '-' + idCounter.toString(36) + '-' +
      Math.floor(Math.random() * 0xffffff).toString(36);
  }
  function addComment(author, text, parentId) {
    var body = String(text == null ? '' : text).trim();
    if (!body) return null;
    var name = String(author == null ? '' : author).trim();
    if (name) setAuthor(name); else name = getAuthor() || 'Anonymous';
    var c = {
      id: newId(), parentId: parentId || null, author: name,
      text: body, timestamp: Date.now()
    };
    comments.push(c);
    persistList();
    return c;
  }
  /* Flat list -> forest. A comment whose parent is missing renders as a
   * root (defensive: keeps orphaned replies visible, never dropped). */
  function buildTree(list) {
    var byId = {}, roots = [];
    list.forEach(function (c) { byId[c.id] = { comment: c, children: [] }; });
    list.forEach(function (c) {
      var node = byId[c.id];
      if (c.parentId && byId[c.parentId]) byId[c.parentId].children.push(node);
      else roots.push(node);
    });
    (function sortRec(nodes) {
      nodes.sort(function (a, b) { return a.comment.timestamp - b.comment.timestamp; });
      nodes.forEach(function (n) { sortRec(n.children); });
    })(roots);
    return roots;
  }
  function fmtTime(ts) {
    return new Date(ts).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
  }
  function exportText() {
    var lines = ['DROP ZONE — playtest feedback (' + comments.length +
      ' comment' + (comments.length === 1 ? '' : 's') + ', exported ' + fmtTime(Date.now()) + ')', ''];
    (function walk(nodes, depth) {
      nodes.forEach(function (n) {
        var c = n.comment, pad = '';
        for (var i = 0; i < depth; i++) pad += '  ';
        c.text.split('\n').forEach(function (line, j) {
          lines.push(j === 0
            ? pad + '[' + fmtTime(c.timestamp) + '] ' + c.author + ': ' + line
            : pad + '    ' + line);
        });
        walk(n.children, depth + 1);
      });
    })(buildTree(comments), 0);
    return lines.join('\n');
  }
  function exportJSON() {
    return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), comments: comments }, null, 2);
  }

  /* Exposed for headless checks and for the future backend swap. */
  root.DropZoneFeedback = {
    add: addComment,
    all: function () { return comments.slice(); },
    tree: function () { return buildTree(comments); },
    exportText: exportText,
    exportJSON: exportJSON,
    getAuthor: getAuthor,
    setAuthor: setAuthor,
    count: function () { return comments.length; }
  };

  /* ---- DOM layer (browser only; guarded so the data layer loads headless) ---- */
  if (typeof document === 'undefined' || !document.getElementById) return;
  var overlay = document.getElementById('feedback-overlay');
  var openBtn = document.getElementById('btn-feedback');
  if (!overlay || !openBtn) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function $(id) { return document.getElementById(id); }
  function setStatus(msg) { var s = $('fb-status'); if (s) s.textContent = msg; }
  function updateCount() {
    openBtn.textContent = comments.length ? 'Feedback (' + comments.length + ')' : 'Feedback';
  }
  function renderList() {
    var listEl = $('feedback-list');
    if (!listEl) return;
    if (!comments.length) {
      listEl.innerHTML = '<p class="fb-empty">No feedback yet — the first note starts the thread.</p>';
      updateCount();
      return;
    }
    var html = '';
    (function walk(nodes, depth) {
      nodes.forEach(function (n) {
        var c = n.comment;
        var indent = Math.min(depth, MAX_DEPTH_INDENT) * 20;
        html += '<div class="fb-comment" style="margin-left:' + indent + 'px">' +
          '<div class="fb-meta"><b>' + esc(c.author) + '</b> · ' + esc(fmtTime(c.timestamp)) + '</div>' +
          '<div class="fb-text-body">' + esc(c.text) + '</div>' +
          '<div class="fb-actions"><button type="button" class="small" data-fb-reply="' + esc(c.id) + '">Reply</button></div>' +
          '<div class="fb-replybox" id="fb-replybox-' + esc(c.id) + '" hidden>' +
            '<textarea rows="2" maxlength="4000" placeholder="Reply to ' + esc(c.author) + '…"></textarea>' +
            '<div><button type="button" class="small primary" data-fb-postreply="' + esc(c.id) + '">Post reply</button> ' +
            '<button type="button" class="small" data-fb-cancelreply="' + esc(c.id) + '">Cancel</button></div>' +
          '</div></div>';
        walk(n.children, depth + 1);
      });
    })(buildTree(comments), 0);
    listEl.innerHTML = html;
    updateCount();
  }
  function openPanel() {
    var authorEl = $('fb-author');
    if (authorEl && !authorEl.value) authorEl.value = getAuthor();
    renderList();
    overlay.hidden = false;
  }
  function closePanel() { overlay.hidden = true; }

  openBtn.addEventListener('click', openPanel);
  $('btn-feedback-close').addEventListener('click', closePanel);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) closePanel(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !overlay.hidden) closePanel();
  });

  $('btn-fb-post').addEventListener('click', function () {
    var c = addComment($('fb-author').value, $('fb-text').value, null);
    if (!c) { setStatus('Write something first.'); return; }
    $('fb-text').value = '';
    setStatus('Posted as ' + c.author + '.');
    renderList();
  });
  $('btn-fb-copy').addEventListener('click', function () {
    var text = exportText();
    function done() { setStatus('All feedback copied as text.'); }
    if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
      root.navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  });
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* clipboard unavailable */ }
    document.body.removeChild(ta);
  }
  $('btn-fb-download').addEventListener('click', function () {
    var blob = new Blob([exportJSON()], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'drop-zone-feedback.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    setStatus('Downloaded drop-zone-feedback.json.');
  });

  /* Thread interactions — one delegated handler for every Reply button. */
  $('feedback-list').addEventListener('click', function (e) {
    var b = e.target;
    if (!b || !b.dataset) return;
    if (b.dataset.fbReply) {
      var box = $('fb-replybox-' + b.dataset.fbReply);
      if (box) {
        var wasHidden = box.hidden;
        Array.prototype.forEach.call(document.querySelectorAll('.fb-replybox'), function (x) { x.hidden = true; });
        box.hidden = !wasHidden;
        if (!box.hidden) { var ta = box.querySelector('textarea'); if (ta) ta.focus(); }
      }
    } else if (b.dataset.fbPostreply) {
      var box2 = $('fb-replybox-' + b.dataset.fbPostreply);
      var ta2 = box2 ? box2.querySelector('textarea') : null;
      var c2 = addComment($('fb-author') ? $('fb-author').value : '', ta2 ? ta2.value : '', b.dataset.fbPostreply);
      if (c2) { setStatus('Reply posted.'); renderList(); }
    } else if (b.dataset.fbCancelreply) {
      var box3 = $('fb-replybox-' + b.dataset.fbCancelreply);
      if (box3) box3.hidden = true;
    }
  });

  updateCount();
})();
