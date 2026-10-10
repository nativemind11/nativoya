// Nativoya Studio — Arabic / English switch.
//
// How it works: every page is written in Arabic. When the language is "en",
// this script translates any Arabic text it finds (page text, placeholders,
// tooltips, alert/confirm messages, and anything the page's JavaScript or the
// server adds later) using the dictionary in js/studio-i18n-dict.js.
// Switching back to Arabic restores the original text.
//
// To translate a new text: add ONE line to js/studio-i18n-dict.js.
// Load order in <head>:  studio-i18n-dict.js  then  studio-i18n.js
(function () {
  "use strict";

  var KEY = "studio_lang";
  var DICT = (window.STUDIO_I18N && window.STUDIO_I18N.en) || {};
  var ARABIC = /[\u0600-\u06FF]/;
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, NOSCRIPT: 1 };
  var ATTRS = ["placeholder", "title", "aria-label", "alt"];

  function getLang() {
    try { return localStorage.getItem(KEY) === "en" ? "en" : "ar"; } catch (e) { return "ar"; }
  }
  var lang = getLang();

  // Set direction immediately (before the body paints) to avoid a layout jump.
  function setDir(l) {
    var h = document.documentElement;
    h.setAttribute("lang", l);
    h.setAttribute("dir", l === "en" ? "ltr" : "rtl");
  }
  setDir(lang);
  // Hide the page until the first translation pass, so English users never see a flash of Arabic.
  var hidden = false;
  if (lang === "en") {
    document.documentElement.style.visibility = "hidden";
    hidden = true;
    setTimeout(reveal, 1500); // safety net
  }
  function reveal() {
    if (hidden) { document.documentElement.style.visibility = ""; hidden = false; }
  }

  // ---------- dictionary lookup ----------
  function norm(s) { return s.replace(/\s+/g, " ").trim(); }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  var exact = Object.create(null);
  var patterns = [];
  Object.keys(DICT).forEach(function (k) {
    if (!/\{#?\}/.test(k)) { exact[k] = DICT[k]; return; }
    // "{}" = any text, "{#}" = digits only (use it where a number sits next to other patterns)
    var re = new RegExp("^" + k.split(/(\{#?\})/).map(function (part) {
      return part === "{}" ? "(.*?)" : part === "{#}" ? "(\\d+)" : escRe(part);
    }).join("") + "$");
    patterns.push({ re: re, out: DICT[k], spec: k.replace(/\{#?\}/g, "").length });
  });
  // Most specific (most fixed text) first.
  patterns.sort(function (a, b) { return b.spec - a.spec; });

  function lookup(core, depth) {
    if (Object.prototype.hasOwnProperty.call(exact, core)) return exact[core];
    for (var i = 0; i < patterns.length; i++) {
      var m = patterns[i].re.exec(core);
      if (!m) continue;
      var seq = 0;
      return patterns[i].out.replace(/\{(\d*)\}/g, function (_, n) {
        var g = m[n ? +n : ++seq];
        if (g === undefined) return "";
        return depth < 4 ? tr(g, depth + 1) : g;
      });
    }
    return null;
  }

  // Same as lookup(), but also accepts a leading emoji / symbol / punctuation prefix ("⚠️ ", "— ").
  function lookupP(core, depth) {
    var out = lookup(core, depth);
    if (out !== null) return out;
    var m = /^([^\u0600-\u06FFA-Za-z0-9]+)([\s\S]+)$/.exec(core);
    if (m && ARABIC.test(m[2])) {
      out = lookup(m[2], depth);
      if (out !== null) return m[1] + out;
    }
    return null;
  }

  // Translate a string. Text with no Arabic, or with no dictionary match, is returned unchanged.
  function tr(s, depth) {
    depth = depth || 0;
    if (typeof s !== "string" || !ARABIC.test(s)) return s;
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
    var core = norm(m[2]);
    var out = lookupP(core, depth);
    if (out === null) {
      // Several sentences joined together: translate the longest known runs of sentences.
      var parts = core.match(/[^.!؟?]+[.!؟?]+\s*|[^.!؟?]+$/g);
      if (parts && parts.length > 1) {
        var res = [], changed = false, i = 0;
        while (i < parts.length) {
          var hit = false;
          for (var j = parts.length; j > i; j--) {
            var t = lookupP(norm(parts.slice(i, j).join(" ")), depth);
            if (t !== null) { res.push(t); changed = true; i = j; hit = true; break; }
          }
          if (!hit) { res.push(parts[i].trim()); i++; }
        }
        if (changed) out = res.join(" ");
      }
    }
    return out === null ? s : m[1] + out + m[3];
  }

  // ---------- DOM translation (with undo) ----------
  var textRec = new WeakMap();   // text node -> { src, out }
  var attrRec = new WeakMap();   // element -> { attr: { src, out } }

  function skipNode(n) {
    for (var p = n.parentNode; p && p.nodeType === 1; p = p.parentNode) {
      if (SKIP[p.nodeName] === 1 || (p.hasAttribute && p.hasAttribute("data-no-i18n"))) return true;
    }
    return false;
  }

  function doText(n) {
    var v = n.nodeValue, r = textRec.get(n);
    if (r && v === r.out) return;                 // our own output
    if (!ARABIC.test(v)) { if (r) textRec.delete(n); return; }
    if (skipNode(n)) return;
    var out = tr(v);
    textRec.set(n, { src: v, out: out });
    if (out !== v) n.nodeValue = out;
  }
  function undoText(n) {
    var r = textRec.get(n);
    if (r && n.nodeValue === r.out) n.nodeValue = r.src;
    textRec.delete(n);
  }

  function attrList(el) {
    var l = ATTRS.slice();
    if (el.nodeName === "INPUT" && /^(submit|button|reset)$/i.test(el.getAttribute("type") || "")) l.push("value");
    return l;
  }
  function doAttrs(el) {
    var list = attrList(el), rec = attrRec.get(el) || {};
    list.forEach(function (a) {
      if (!el.hasAttribute(a)) return;
      var v = el.getAttribute(a), r = rec[a];
      if (r && v === r.out) return;
      if (!ARABIC.test(v)) { delete rec[a]; return; }
      var out = tr(v);
      rec[a] = { src: v, out: out };
      if (out !== v) el.setAttribute(a, out);
    });
    attrRec.set(el, rec);
  }
  function undoAttrs(el) {
    var rec = attrRec.get(el);
    if (!rec) return;
    Object.keys(rec).forEach(function (a) {
      if (el.getAttribute(a) === rec[a].out) el.setAttribute(a, rec[a].src);
    });
    attrRec.delete(el);
  }

  function walk(root, fnText, fnEl) {
    if (!root) return;
    if (root.nodeType === 3) { fnText(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1 && fnEl) fnEl(root);
    var tw = document.createTreeWalker(root, 1 | 4, null, false), n;
    while ((n = tw.nextNode())) {
      if (n.nodeType === 3) fnText(n); else if (fnEl) fnEl(n);
    }
  }

  // ---------- live updates ----------
  var observer = null;
  function onMutations(list) {
    if (lang !== "en") return;
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m.type === "characterData") doText(m.target);
      else if (m.type === "attributes") doAttrs(m.target);
      else if (m.type === "childList") {
        for (var j = 0; j < m.addedNodes.length; j++) walk(m.addedNodes[j], doText, doAttrs);
      }
    }
  }
  function startObserver() {
    if (observer || !window.MutationObserver) return;
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ATTRS.concat(["value"]),
    });
  }

  function applyAll() {
    if (lang === "en") walk(document.documentElement, doText, doAttrs);
    else walk(document.documentElement, undoText, undoAttrs);
  }

  // ---------- AR / EN button ----------
  function injectToggle() {
    if (document.getElementById("studio-lang-toggle")) return;
    var header = document.querySelector(".studio-header");
    var box = document.createElement("div");
    box.className = "studio-lang";
    box.id = "studio-lang-toggle";
    box.setAttribute("data-no-i18n", "");
    box.innerHTML = '<button type="button" data-l="ar">AR</button><button type="button" data-l="en">EN</button>';
    box.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("button[data-l]");
      if (b) setLang(b.getAttribute("data-l"));
    });
    if (header) {
      var nav = header.querySelector("nav");
      if (!nav) {  // headers with no <nav>: group everything after the logo so the button sits at the end
        nav = document.createElement("nav");
        var kids = Array.prototype.slice.call(header.children, 1);
        kids.forEach(function (k) { nav.appendChild(k); });
        header.appendChild(nav);
      }
      nav.appendChild(box);
    } else {
      box.className += " studio-lang-floating";
      document.body.appendChild(box);
    }
    markActive();
  }
  function markActive() {
    var box = document.getElementById("studio-lang-toggle");
    if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll("button"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-l") === lang);
    });
  }

  function setLang(l) {
    l = l === "en" ? "en" : "ar";
    if (l === lang) return;
    try { localStorage.setItem(KEY, l); } catch (e) {}
    // Pages that format dates/numbers when they render are simply reloaded in the new language.
    if (document.body && document.body.hasAttribute("data-i18n-reload")) { location.reload(); return; }
    lang = l;
    setDir(l);
    if (l === "en") startObserver();
    applyAll();
    markActive();
  }

  // ---------- dates, alert / confirm / prompt ----------
  ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"].forEach(function (name) {
    var orig = Date.prototype[name];
    Date.prototype[name] = function (loc, opts) {
      if (lang === "en" && typeof loc === "string" && /^ar/i.test(loc)) loc = "en-GB";
      return orig.call(this, loc, opts);
    };
  });
  ["alert", "confirm", "prompt"].forEach(function (name) {
    var orig = window[name];
    if (typeof orig !== "function") return;
    window[name] = function (msg) {
      var args = Array.prototype.slice.call(arguments);
      if (lang === "en" && args.length) args[0] = tr(String(args[0]));
      return orig.apply(window, args);
    };
  });

  window.StudioI18n = { t: tr, getLang: function () { return lang; }, setLang: setLang };

  // ---------- start ----------
  if (lang === "en") startObserver();   // translate content as the page is parsed
  function ready() {
    injectToggle();
    if (lang === "en") startObserver();
    applyAll();
    reveal();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
  else ready();
})();
