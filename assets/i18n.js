/*
 * Localization engine (Phase 6):
 * 1) Semantic keys via window.bumperT(key) / data-i18n attributes (locales/*.json)
 * 2) Legacy English-source overlay for unmigrated DOM (i18n.ja.json)
 *
 * Language lives in localStorage bumper-ui-lang. Settings owns the selector;
 * this script no longer injects a duplicate row.
 *
 * Perf: MutationObserver is debounced and ignores SVG/icon churn from lucide.
 * characterData is not observed — text updates go through bumperApplyI18n / render paths.
 * Live updates translate only added subtrees (not document.body) to avoid scroll jank.
 */
(() => {
  "use strict";

  const STORAGE_KEY = "bumper-ui-lang";
  const ATTRS = ["placeholder", "title", "aria-label"];
  const OVERLAY_MAPS = window.__BUMPER_I18N__ || {};
  const LOCALES = window.__BUMPER_LOCALES__ || {};
  const DEBOUNCE_MS = 80;

  function currentLang() {
    try {
      return localStorage.getItem(STORAGE_KEY) || "en";
    } catch (_) {
      return "en";
    }
  }

  let lang = currentLang();
  const overlayMap = OVERLAY_MAPS[lang] || null;
  const semantic = LOCALES[lang] || LOCALES.en || {};

  const dict = {};
  const patterns = [];
  if (overlayMap) {
    for (const key in overlayMap) {
      if (key === "$patterns" || !Object.prototype.hasOwnProperty.call(overlayMap, key)) continue;
      dict[key] = overlayMap[key];
    }
    for (const rule of overlayMap.$patterns || []) {
      try { patterns.push([new RegExp(rule.re), rule.to]); } catch (_) { /* skip */ }
    }
  }

  function t(key, vars) {
    let out = semantic[key];
    if (out == null && LOCALES.en) out = LOCALES.en[key];
    if (out == null) out = key;
    if (vars && typeof out === "string") {
      out = out.replace(/\{(\w+)\}/g, (_, name) => (vars[name] != null ? String(vars[name]) : `{${name}}`));
    }
    return out;
  }

  window.bumperT = t;
  window.bumperLang = () => lang;
  window.setBumperLang = (next) => {
    try { localStorage.setItem(STORAGE_KEY, next); } catch (_) { /* ignore */ }
    location.reload();
  };

  function translateOverlay(text) {
    const key = text.trim();
    if (!key) return null;
    if (Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
    for (const [re, to] of patterns) if (re.test(key)) return key.replace(re, to);
    return null;
  }

  function applySemantic(root) {
    const scope = root.querySelectorAll ? root : document;
    const nodes = root.querySelectorAll
      ? root.querySelectorAll("[data-i18n], [data-i18n-placeholder], [data-i18n-aria-label], [data-i18n-title]")
      : document.querySelectorAll("[data-i18n], [data-i18n-placeholder], [data-i18n-aria-label], [data-i18n-title]");
    nodes.forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (key) {
        const value = t(key);
        if (el.tagName === "OPTION" || el.tagName === "TITLE") el.textContent = value;
        else if (el.childElementCount === 0) el.textContent = value;
        else {
          const span = el.querySelector("[data-i18n-text]");
          if (span) span.textContent = value;
        }
      }
      const ph = el.getAttribute("data-i18n-placeholder");
      if (ph) el.setAttribute("placeholder", t(ph));
      const al = el.getAttribute("data-i18n-aria-label");
      if (al) el.setAttribute("aria-label", t(al));
      const ti = el.getAttribute("data-i18n-title");
      if (ti) el.setAttribute("title", t(ti));
    });
    if (root.nodeType === Node.ELEMENT_NODE && root.hasAttribute && root.hasAttribute("data-i18n")) {
      const key = root.getAttribute("data-i18n");
      if (key && root.childElementCount === 0) root.textContent = t(key);
    }
  }

  function translateTextNode(node) {
    let p = node.parentElement;
    while (p) {
      if (p.hasAttribute && p.hasAttribute("data-i18n")) return;
      if (p.tagName === "SVG" || p.closest?.("svg")) return;
      p = p.parentElement;
    }
    const raw = node.nodeValue;
    const key = raw.trim();
    if (!key) return;
    const out = translateOverlay(key);
    if (out != null && out !== key) node.nodeValue = raw.replace(key, out);
  }

  function translateAttrs(el) {
    if (!el.getAttribute || el.hasAttribute("data-i18n")) return;
    if (el.tagName === "SVG" || el.closest?.("svg")) return;
    for (const attr of ATTRS) {
      if (!el.hasAttribute(attr)) continue;
      const value = el.getAttribute(attr);
      const out = translateOverlay(value);
      if (out != null && out !== value) el.setAttribute(attr, out);
    }
  }

  function translateTree(root) {
    applySemantic(root);
    if (!overlayMap) return;
    if (root.nodeType === Node.ELEMENT_NODE) translateAttrs(root);
    if (root.querySelectorAll) {
      root.querySelectorAll("*:not(svg):not(svg *)").forEach(translateAttrs);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent || parent.closest("svg")) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let node;
      while ((node = walker.nextNode())) translateTextNode(node);
    }
  }

  let observer = null;
  let busy = false;
  let debounceTimer = 0;
  /** @type {Set<Node>|null} null = full body; Set = scoped roots to translate */
  let pendingRoots = null;

  function runTranslate(root) {
    if (busy) return;
    const target = root && root.nodeType ? root : document.body;
    busy = true;
    if (observer) observer.disconnect();
    try {
      translateTree(target);
      if (target === document.body) {
        const titleKey = document.body?.dataset?.i18nTitle;
        if (titleKey) document.title = t(titleKey);
        else if (overlayMap) {
          const title = translateOverlay(document.title);
          if (title != null) document.title = title;
        }
      }
    } catch (_) { /* never break the app */ }
    finally {
      if (observer) observer.observe(document.body, { childList: true, subtree: true });
      busy = false;
    }
  }

  function collectAddedRoots(mutations) {
    const roots = [];
    for (const mutation of mutations) {
      if (mutation.type !== "childList") continue;
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.tagName === "SVG" || node.closest?.("svg")) continue;
          roots.push(node);
        } else if (node.nodeType === Node.TEXT_NODE && node.parentElement) {
          if (node.parentElement.closest?.("svg")) continue;
          roots.push(node.parentElement);
        }
      }
    }
    return roots;
  }

  function scheduleTranslate(mutations) {
    if (busy) return;
    if (mutations && mutations.length) {
      const roots = collectAddedRoots(mutations);
      if (!roots.length) return;
      if (pendingRoots === null && debounceTimer) {
        // A full-body pass is already queued — keep it.
      } else {
        if (!pendingRoots) pendingRoots = new Set();
        for (const root of roots) pendingRoots.add(root);
      }
    } else {
      pendingRoots = null;
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = 0;
      const batch = pendingRoots;
      pendingRoots = null;
      if (batch === null) {
        runTranslate(document.body);
        return;
      }
      for (const root of batch) {
        if (root.isConnected) runTranslate(root);
      }
    }, DEBOUNCE_MS);
  }

  window.bumperApplyI18n = (root) => runTranslate(root && root.nodeType ? root : document.body);

  function startLive() {
    observer = new MutationObserver(scheduleTranslate);
    runTranslate(document.body);
  }

  function boot() {
    startLive();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
