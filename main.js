"use strict";

const {
  Plugin,
  PluginSettingTab,
  SecretComponent,
  Setting,
  editorInfoField,
  editorLivePreviewField,
  getLanguage,
  normalizePath,
  requestUrl,
  setIcon,
} = require("obsidian");
const { ViewPlugin } = require("@codemirror/view");

const NOTE_PROPERTY = "english-hover";
const LEARNERS_NAME = "Merriam-Webster's Learner's Dictionary with Audio";
const LEARNERS_ENDPOINT = "https://www.dictionaryapi.com/api/v3/references/learners/json/";
const LEARNERS_AUDIO_BASE = "https://media.merriam-webster.com/audio/prons/en/us/mp3/";
const LOOKUP_CACHE_KEY = "palimserest-learners-cache-v1";
const HOUR_MS = 60 * 60 * 1000;
const LEGACY_CACHE_HOURS = 7 * 24;
const LEGACY_MAX_SENSES = 3;
const REQUEST_COUNT_KEY = "palimserest-daily-requests";
const HOVER_STYLES = ["fill", "underline"];
const ENGLISH_WORD = /\p{Script=Latin}[\p{Script=Latin}\p{M}]*(?:['’ʼ\-‐‑]\p{Script=Latin}[\p{Script=Latin}\p{M}]*)*/gu;

const NUMBER_SETTINGS = {
  hoverDelay: { defaultValue: 300, min: 0, max: 10_000 },
  maxSenses: { defaultValue: LEGACY_MAX_SENSES, min: 1, max: 30 },
  maxWordLength: { defaultValue: 80, min: 1, max: 256 },
  maxSelectionLength: { defaultValue: 80, min: 1, max: 256 },
  selectionExitDelay: { defaultValue: 220, min: 0, max: 2000 },
  loadingDelay: { defaultValue: 180, min: 0, max: 10_000 },
  requestTimeout: { defaultValue: 2500, min: 100, max: 60_000 },
  autoRetries: { defaultValue: 1, min: 0, max: 5 },
  retryDelay: { defaultValue: 500, min: 0, max: 10_000 },
  cacheLimit: { defaultValue: 512, min: 0, max: 4096 },
  cacheMaxAgeHours: { defaultValue: LEGACY_CACHE_HOURS, min: 0, max: 8760 },
};

const READING_TEXT = "p, li, blockquote, h1, h2, h3, h4, h5, h6";
const SKIP_RENDERED = "a, code, pre, .math, mjx-container, .internal-embed, .markdown-embed, .metadata-container, .footnote-ref, img, svg";
const SKIP_EDITOR = [
  ".cm-formatting", ".cm-link", ".cm-url", ".cm-hmd-internal-link",
  ".cm-hmd-barelink", ".cm-hmd-footnote", ".cm-inline-code", ".cm-math",
  ".HyperMD-codeblock", ".HyperMD-frontmatter", ".HyperMD-math",
].join(", ");
const SKIP_EDITOR_SELECTION = `${SKIP_RENDERED}, ${SKIP_EDITOR}`;

// These example definitions and synthesized clips are separate from the online dictionary.
const EXAMPLES = {
  subtle: [
    ["subtle", "adjective", "Hard to notice or recognize.", "ˈsʌtəl", "subtle"],
  ],
  yield: [
    ["yield", "noun", "The amount produced.", "jiːld", "yield"],
    ["yield", "verb", "To produce or provide something.", "jiːld", "yield"],
  ],
  record: [
    ["record", "noun", "Information kept about something.", "ˈrɛkɚd", "record-noun"],
    ["record", "verb", "To save sound, images, or information.", "rɪˈkɔɹd", "record-verb"],
  ],
  ran: [
    ["run", "verb", "To move quickly on foot.", "ræn", "ran"],
  ],
  run: [
    ["run", "verb", "To move quickly on foot.", "rʌn", "run"],
  ],
  play: [
    ["play", "verb", "To take part in a game or perform a piece of music.", "pleɪ"],
  ],
  "take off": [
    ["take off", "phrasal verb", "To leave the ground and begin to fly."],
  ],
};

async function readCatalog(adapter, path) {
  const text = await adapter.read(path);
  const catalog = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error(`Invalid Palimserest locale catalog at ${path}`);
  }
  return Object.fromEntries(Object.entries(catalog).filter(([, message]) =>
    typeof message === "string" && message.trim()
  ));
}

async function loadTranslator(adapter, directory, language) {
  const catalogPath = locale => normalizePath(`${directory}/locales/${locale}.json`);
  let messages = await readCatalog(adapter, catalogPath("en"));
  const locale = language.toLowerCase().split("-")[0];
  if (locale !== "en" && /^[a-z]{2,3}$/.test(locale)) {
    const path = catalogPath(locale);
    try {
      if (await adapter.exists(path)) {
        const localized = await readCatalog(adapter, path);
        messages = { ...messages, ...localized };
      }
    } catch (error) {
      console.warn(`Palimserest could not read locale ${locale}.`, error);
    }
  }

  return (key, values = {}) => {
    const template = Object.hasOwn(messages, key) ? messages[key] : key;
    return template.replace(/\{(\w+)\}/g, (placeholder, name) =>
      Object.hasOwn(values, name) ? String(values[name]) : placeholder
    );
  };
}

function spelling(word) {
  return word.normalize("NFC").replace(/[’ʼ]/g, "'").replace(/[‐‑]/g, "-");
}

function wordKey(word) {
  return spelling(word).toLowerCase();
}

function wordAt(text, offset, maxLength) {
  for (const match of text.matchAll(ENGLISH_WORD)) {
    const from = match.index;
    if (from > offset) break;
    const to = from + match[0].length;
    if (offset > to || match[0].length > maxLength) continue;
    if (/[\p{N}_]/u.test(text[from - 1] ?? "") || /[\p{N}_]/u.test(text[to] ?? "")) continue;
    return { text: match[0], from, to };
  }
  return null;
}

function containsPoint(rect, x, y) {
  return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
}

function rectAt(range, x, y) {
  return Array.from(range.getClientRects()).find(rect => containsPoint(rect, x, y));
}

function selectionRects(range, excluded) {
  const root = range.commonAncestorContainer;
  const element = root.nodeType === 1 ? root : root.parentElement;
  if (!element || element.closest(excluded)) return [];
  if (root.nodeType === 3) return Array.from(range.getClientRects()).filter(rect => rect.width && rect.height);

  // A DOM range also reports boxes for fully selected elements. Use only the text fragments.
  const document = root.ownerDocument;
  const { SHOW_ELEMENT, SHOW_TEXT, FILTER_ACCEPT, FILTER_REJECT } = document.defaultView.NodeFilter;
  const walker = document.createTreeWalker(root, SHOW_ELEMENT | SHOW_TEXT, {
    acceptNode: node => range.intersectsNode(node) ? FILTER_ACCEPT : FILTER_REJECT,
  });
  const rects = [];
  const fragment = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 1) {
      if (node.matches(excluded)) return [];
      continue;
    }
    const from = node === range.startContainer ? range.startOffset : 0;
    const to = node === range.endContainer ? range.endOffset : node.length;
    if (from >= to) continue;
    fragment.setStart(node, from);
    fragment.setEnd(node, to);
    for (const rect of fragment.getClientRects()) {
      if (rect.width && rect.height) rects.push(rect);
    }
  }
  return rects;
}

function editorDOMRange(view, from, to) {
  const start = view.domAtPos(from);
  const end = view.domAtPos(to, -1);
  const range = view.dom.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

function wordLineRects(range) {
  // Merge inline fragments on the same line and give wrapped lines their own pill.
  const lines = [];
  for (const { left, top, right, bottom, width, height } of range.getClientRects()) {
    if (width <= 0 || height <= 0) continue;
    const middle = (top + bottom) / 2;
    const line = lines.find(line => Math.abs(line.middle - middle) < height / 2);
    if (line) {
      line.left = Math.min(line.left, left);
      line.top = Math.min(line.top, top);
      line.right = Math.max(line.right, right);
      line.bottom = Math.max(line.bottom, bottom);
    } else {
      lines.push({ left, top, right, bottom, middle });
    }
  }
  return lines;
}

function sameHit(a, b) {
  if (!a || !b || a.kind !== b.kind || a.owner !== b.owner || a.path !== b.path || a.text !== b.text) return false;
  // Live Preview can rebuild its text nodes when a click moves the caret.
  if (a.editorFrom !== undefined) return a.editorFrom === b.editorFrom && a.editorTo === b.editorTo;
  return a.range.startContainer === b.range.startContainer && a.range.startOffset === b.range.startOffset &&
    a.range.endContainer === b.range.endContainer && a.range.endOffset === b.range.endOffset;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function localDateKey() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return now.getFullYear() + "-" + month + "-" + day;
}

function headword(value) {
  return typeof value === "string" ? value.replace(/\*/g, "").replace(/:\d+$/, "").trim() : "";
}

function audioUrl(id) {
  if (typeof id !== "string" || !/^[a-z0-9_-]+$/i.test(id)) return "";
  const subdirectory = id.startsWith("bix") ? "bix"
    : id.startsWith("gg") ? "gg"
    : /^[0-9_-]/.test(id) ? "number"
    : id[0];
  return LEARNERS_AUDIO_BASE + subdirectory + "/" + id + ".mp3";
}

function pronunciations(records, form) {
  return array(records).flatMap(record => {
    const ipa = typeof record?.ipa === "string" ? record.ipa.trim() : "";
    const url = audioUrl(record?.sound?.audio);
    if (!ipa && !url) return [];
    const label = [record.l, record.l2].filter(value => typeof value === "string").join(" ").trim();
    return [{ form, ipa, url, label }];
  });
}

function parseLearners(payload, query) {
  const key = wordKey(query);
  const entries = array(payload).flatMap(entry => {
    const word = headword(entry?.hwi?.hw || entry?.meta?.id);
    if (!word) return [];
    const exact = wordKey(word) === key;
    const inflection = array(entry.ins).find(item => wordKey(headword(item?.if)) === key);
    const stems = array(entry.meta?.stems);
    if (!exact && !inflection && !stems.some(stem => wordKey(headword(stem)) === key)) return [];

    const definitions = array(entry.shortdef).filter(value => typeof value === "string" && value.trim());
    const variants = pronunciations(inflection?.prs, query);
    const base = pronunciations(entry.hwi?.prs, word);
    const available = variants.length ? variants : base;
    if (variants.length && !variants.some(pronunciation => pronunciation.url)) {
      available.push(...base.filter(pronunciation => pronunciation.url));
    }
    return [{
      exact,
      word,
      part: typeof entry.fl === "string" ? entry.fl : "",
      definitions,
      pronunciations: available,
    }];
  });

  // A stem can map to more than one headword. Preserve those choices after exact matches.
  entries.sort((a, b) => Number(b.exact) - Number(a.exact));
  return entries.filter(entry => entry.definitions.length);
}

function limitSenses(groups, maxSenses) {
  const visible = groups.slice(0, maxSenses);
  let remaining = maxSenses - visible.length;
  return visible.map(group => {
    const extra = Math.min(remaining, group.definitions.length - 1);
    remaining -= extra;
    return { ...group, definitions: group.definitions.slice(0, 1 + extra) };
  });
}

class LookupError extends Error {
  constructor(code, retry = false) {
    super(code);
    this.code = code;
    this.retry = retry;
  }
}

function waitForRetry(delay, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delay);
    function abort() {
      window.clearTimeout(timer);
      reject(signal.reason);
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function isCachedGroup(group) {
  return typeof group?.word === "string" && typeof group.part === "string" &&
    Array.isArray(group.definitions) && group.definitions.every(definition => typeof definition === "string") &&
    Array.isArray(group.pronunciations) && group.pronunciations.every(pronunciation =>
      typeof pronunciation?.form === "string" && typeof pronunciation.ipa === "string" &&
      typeof pronunciation.label === "string" && typeof pronunciation.url === "string" &&
      (pronunciation.url === "" || pronunciation.url.startsWith(LEARNERS_AUDIO_BASE))
    );
}

class Dictionary {
  constructor(plugin, onRequestCountChange) {
    this.plugin = plugin;
    this.onRequestCountChange = onRequestCountChange;
    this.inFlight = new Map();

    const savedCache = array(this.loadLocal(LOOKUP_CACHE_KEY));
    this.cache = new Map();
    for (const entry of savedCache) {
      if (typeof entry?.query !== "string" || !Array.isArray(entry.groups) || !entry.groups.every(isCachedGroup)) continue;
      const cachedAt = entry.cachedAt ?? (entry.expiresAt - LEGACY_CACHE_HOURS * HOUR_MS);
      if (Number.isFinite(cachedAt)) this.cache.set(entry.query, { ...entry, cachedAt });
    }
    this.pruneCache(this.cache.size !== savedCache.length);

    const usage = this.loadLocal(REQUEST_COUNT_KEY);
    this.usage = typeof usage?.date === "string" && Number.isSafeInteger(usage.count) && usage.count >= 0
      ? usage
      : { date: "", count: 0 };
  }

  loadLocal(key) {
    try {
      return this.plugin.app.loadLocalStorage(key);
    } catch {
      return null;
    }
  }

  saveLocal(key, value) {
    try {
      this.plugin.app.saveLocalStorage(key, value);
    } catch (error) {
      console.warn("Palimserest could not save local dictionary data.", error);
    }
  }

  get todayRequestCount() {
    return this.usage.date === localDateKey() ? this.usage.count : 0;
  }

  recordRequest() {
    const date = localDateKey();
    const count = this.usage.date === date ? this.usage.count + 1 : 1;
    this.usage = { date, count };
    this.saveLocal(REQUEST_COUNT_KEY, this.usage);
    this.onRequestCountChange?.();
  }

  cachedLookup(query) {
    const entry = this.cache.get(query);
    if (!entry) return null;
    const { cacheMaxAgeHours, maxSenses } = this.plugin.settings;
    if (entry.cachedAt <= Date.now() - cacheMaxAgeHours * HOUR_MS) {
      this.pruneCache();
      return null;
    }
    // Refresh a legacy entry if its original display limit may have truncated it.
    if (Number.isFinite(entry.expiresAt) && maxSenses > LEGACY_MAX_SENSES &&
        entry.groups.reduce((count, group) => count + group.definitions.length, 0) >= LEGACY_MAX_SENSES) return null;
    this.cache.delete(query);
    this.cache.set(query, entry);
    return { source: "learners", groups: entry.groups };
  }

  rememberLookup(query, groups) {
    if (!this.plugin.settings.cacheLimit || !this.plugin.settings.cacheMaxAgeHours) return;
    this.cache.delete(query);
    this.cache.set(query, { query, groups, cachedAt: Date.now() });
    this.pruneCache(true);
  }

  pruneCache(dirty = false) {
    const { cacheLimit, cacheMaxAgeHours } = this.plugin.settings;
    const cutoff = Date.now() - cacheMaxAgeHours * HOUR_MS;
    const oldSize = this.cache.size;
    for (const [query, entry] of this.cache) {
      if (entry.cachedAt <= cutoff) this.cache.delete(query);
    }
    const limit = cacheMaxAgeHours === 0 ? 0 : cacheLimit;
    while (this.cache.size > limit) this.cache.delete(this.cache.keys().next().value);
    if (dirty || this.cache.size !== oldSize) this.saveLocal(LOOKUP_CACHE_KEY, [...this.cache.values()]);
  }

  async lookup(text, { signal, onRetry } = {}) {
    signal?.throwIfAborted();
    const query = spelling(text.trim().replace(/\s+/g, " "));
    if (this.plugin.settings.provider !== "learners") {
      const samples = Object.hasOwn(EXAMPLES, wordKey(query)) ? EXAMPLES[wordKey(query)] : [];
      return {
        source: "sample",
        groups: samples.map(([word, part, definition, ipa, clip]) => ({
          word,
          part,
          definitions: [definition],
          pronunciations: ipa || clip ? [{
            form: clip === "ran" ? "ran" : word,
            ipa: ipa ?? "",
            url: clip ? this.plugin.exampleAudio(clip) : "",
            label: "",
          }] : [],
        })),
      };
    }

    const secretName = this.plugin.settings.secretName;
    const key = secretName && this.plugin.app.secretStorage.getSecret(secretName)?.trim();
    if (!key) throw new LookupError("missingKey");

    // Each lookup owns its retry schedule. Concurrent lookups can share a network attempt.
    const { autoRetries, retryDelay } = this.plugin.settings;
    for (let remaining = autoRetries; ; remaining--) {
      signal?.throwIfAborted();
      let result;
      try {
        result = await this.lookupLearners(query, key);
      } catch (error) {
        signal?.throwIfAborted();
        const retryable = error instanceof LookupError && error.retry && remaining > 0;
        if (!retryable) throw error;
        onRetry?.();
        await waitForRetry(retryDelay, signal);
        continue;
      }
      signal?.throwIfAborted();
      return result;
    }
  }

  lookupLearners(query, key) {
    const cached = this.cachedLookup(query);
    if (cached) return cached;
    const existing = this.inFlight.get(query);
    if (existing) return existing;

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = window.setTimeout(() => reject(new LookupError("timeout", true)), this.plugin.settings.requestTimeout);
    });
    const request = Promise.race([this.fetch(query, key), timeout])
      .then(result => {
        if (this.inFlight.get(query) === request) this.rememberLookup(query, result.groups);
        return result;
      })
      .finally(() => {
        window.clearTimeout(timer);
        if (this.inFlight.get(query) === request) this.inFlight.delete(query);
      });
    this.inFlight.set(query, request);
    return request;
  }

  invalidateRequests() {
    this.inFlight.clear();
  }

  async fetch(query, key) {
    let response;
    try {
      const url = LEARNERS_ENDPOINT + encodeURIComponent(query) + "?key=" + encodeURIComponent(key);
      this.recordRequest();
      response = await requestUrl({ url, throw: false });
    } catch {
      throw new LookupError("connection", true);
    }
    if (response.status === 401 || response.status === 403) {
      throw new LookupError("rejectedKey");
    }
    if (response.status === 408) throw new LookupError("timeout", true);
    if (response.status === 429) throw new LookupError("rateLimit");
    if (response.status === 404) return { source: "learners", groups: [] };
    if (response.status >= 400) throw new LookupError("unavailable", response.status >= 500);

    let payload;
    try {
      payload = response.json;
    } catch {
      throw new LookupError("invalidResponse", true);
    }
    if (typeof payload === "string" && /(?:api key|not authorized|access denied)/i.test(payload)) {
      throw new LookupError("rejectedKey");
    }
    if (!Array.isArray(payload)) throw new LookupError("invalidResponse", true);
    return { source: "learners", groups: parseLearners(payload, query) };
  }
}

function addElement(parent, tag, className, text) {
  const element = parent.ownerDocument.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  parent.appendChild(element);
  return element;
}

function externalLink(parent, label, url) {
  const link = addElement(parent, "a", "external-link", label);
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

class LookupInteraction {
  constructor(plugin, document) {
    this.plugin = plugin;
    this.document = document;
    this.window = document.defaultView;
    this.events = new this.window.AbortController();
    this.hoverLayer = addElement(document.body, "div", "palimserest-hover-layer");
    this.hoverLayer.setAttribute("aria-hidden", "true");
    this.selectionButton = addElement(document.body, "button", "palimserest-selection-button");
    this.selectionButton.type = "button";
    this.selectionButton.hidden = true;
    setIcon(this.selectionButton, "search");
    this.selectionButton.append(plugin.t("selection.lookup"));
    this.card = new LookupCard(document, plugin.t);

    const listen = (target, event, callback, options) => {
      target.addEventListener(event, callback, { ...options, signal: this.events.signal });
    };
    listen(document, "pointermove", event => this.pointerMove(event), { passive: true });
    listen(document, "pointerdown", event => this.pointerDown(event), { capture: true });
    listen(document, "pointercancel", () => this.resetHover());
    listen(document, "contextmenu", () => this.resetHover());
    listen(document, "click", event => this.click(event), { capture: true });
    listen(document, "pointerout", event => {
      if (!event.relatedTarget) {
        this.pointer = null;
        this.resetHover();
      }
    });
    listen(document, "scroll", event => {
      if (!this.card.element.contains(event.target)) this.resetHover();
    }, { capture: true, passive: true });
    listen(document, "selectionchange", () => this.selectionChanged());
    listen(document, "keydown", event => {
      if (event.key !== "Escape") return;
      const hit = this.pending ?? this.ready ?? this.pressed ?? this.active?.hit;
      this.dismiss();
      this.dismissedHit = hit;
    });
    listen(this.card.element, "pointerenter", () => this.resetHover());
    listen(this.selectionButton, "mousedown", event => {
      // Keep the selection and editor focus when pressing the button.
      if (event.button === 0) event.preventDefault();
    });
    listen(this.selectionButton, "click", () => this.openSelection());
    listen(this.window, "blur", () => this.resetHover());
    listen(this.window, "resize", () => {
      this.resetHover();
      if (this.active && !this.card.element.hidden) this.card.show(this.active.hit.rect);
    });
  }

  pointerMove(event) {
    if (event.pointerType === "touch") return;
    const moved = event.clientX !== this.pointer?.clientX || event.clientY !== this.pointer?.clientY;
    this.pointer = event;
    if (this.card.element.contains(event.target)) return;
    if (this.selectionButton.contains(event.target)) {
      this.cancelFrame();
      this.cancelSelectionExit();
      return;
    }
    if (event.buttons) {
      if (!this.pressed || !sameHit(this.pressed, this.hitAtPointer(event))) this.resetHover();
      return;
    }
    // Scroll and Escape can leave the pointer over the old word. Wait for a new movement.
    if (!moved || this.frame) return;
    this.frame = this.window.requestAnimationFrame(() => {
      this.frame = 0;
      this.track(this.hitAtPointer(this.pointer));
    });
  }

  pointerDown(event) {
    if (this.card.element.contains(event.target) || this.selectionButton.contains(event.target)) return;
    let pressed = null;
    if (this.ready?.kind === "word" && event.button === 0 && event.pointerType !== "touch" &&
        !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const hit = this.hitAtPointer(event);
      if (sameHit(hit, this.ready)) pressed = hit;
    }
    this.resetHover();
    this.pressed = pressed;
  }

  click(event) {
    const pressed = this.pressed;
    this.pressed = null;
    if (event.button !== 0 || this.card.element.contains(event.target) || this.selectionButton.contains(event.target)) return;
    const activate = pressed && event.detail !== 0 && !event.defaultPrevented;
    const hit = activate ? this.hitAtPointer(event) : null;
    if (sameHit(hit, pressed)) this.open(hit);
    else this.dismiss();
  }

  hitAtPointer({ clientX, clientY }) {
    const target = this.document.elementFromPoint(clientX, clientY);
    if (!target || this.card.element.contains(target) || this.selectionButton.contains(target)) return null;
    return this.plugin.hitAt(target, clientX, clientY, this.domSelection());
  }

  domSelection() {
    const selection = this.document.getSelection();
    return selection && !selection.isCollapsed && !this.card.element.contains(selection.anchorNode) ? selection : null;
  }

  selectionChanged() {
    const tracked = this.ready ?? this.pending;
    if (tracked?.kind === "selection") {
      if (!sameHit(tracked, this.plugin.selectionFor(tracked))) this.resetHover();
    } else if (this.domSelection()) {
      this.resetHover();
    }
  }

  track(hit) {
    if (sameHit(hit, this.dismissedHit)) return;
    this.dismissedHit = null;
    if (sameHit(hit, this.active?.hit)) {
      this.clearHover();
      return;
    }
    if (sameHit(hit, this.pending) || sameHit(hit, this.ready)) {
      this.cancelSelectionExit();
      return;
    }
    if (!hit && this.ready?.kind === "selection") {
      this.selectionExitTimer ??= this.window.setTimeout(() => this.clearHover(), this.plugin.settings.selectionExitDelay);
      return;
    }
    this.clearHover();
    if (!hit) return;
    this.pending = hit;
    this.dwellTimer = this.window.setTimeout(() => {
      this.pending = null;
      const current = this.hitAtPointer(this.pointer);
      if (!sameHit(hit, current)) return;
      this.showHover(current);
    }, this.plugin.settings.hoverDelay);
  }

  showHover(hit) {
    this.ready = hit;
    if (hit.kind === "selection") {
      this.showSelectionButton(hit);
      return;
    }
    hit.owner.classList.add("palimserest-hover-target");
    this.hoverLayer.dataset.style = this.plugin.settings.hoverStyle;
    for (const { left, top, right, bottom } of wordLineRects(hit.range)) {
      const mark = addElement(this.hoverLayer, "span", "palimserest-hover-mark");
      Object.assign(mark.style, {
        left: left + "px",
        top: top + "px",
        width: right - left + "px",
        height: bottom - top + "px",
      });
    }
  }

  showSelectionButton(hit) {
    const { selectionButton: button, window } = this;
    const margin = 8;
    const gap = 6;
    // Exclude text fragments clipped by the note's scroller or covered by pane chrome.
    const visible = hit.rects.filter(rect => hit.owner.contains(this.document.elementFromPoint(
      (rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2
    )));
    const first = visible[0] ?? hit.rect;
    const last = visible.at(-1) ?? hit.rect;
    button.hidden = false;
    const above = first.top - button.offsetHeight - gap;
    const maxLeft = window.innerWidth - button.offsetWidth - margin;
    const maxTop = window.innerHeight - button.offsetHeight - margin;
    button.style.left = Math.max(margin, Math.min(first.left, maxLeft)) + "px";
    button.style.top = Math.max(margin, Math.min(above >= margin ? above : last.bottom + gap, maxTop)) + "px";
  }

  openSelection() {
    const ready = this.ready;
    if (ready?.kind !== "selection") return;
    const selected = this.plugin.selectionFor(ready);
    this.resetHover();
    if (sameHit(ready, selected)) this.open({ ...selected, rect: ready.rect });
  }

  async open(hit) {
    this.cancelLookup();
    const controller = new this.window.AbortController();
    const active = { hit, controller };
    this.active = active;
    const { t } = this.plugin;
    const showLoading = (key = "card.loading") => {
      if (this.checkActive(active)) this.card.status(hit, t(key), "loading");
    };
    const { loadingDelay } = this.plugin.settings;
    if (this.card.element.hidden && loadingDelay) {
      active.loadingTimer = this.window.setTimeout(showLoading, loadingDelay);
    } else {
      showLoading();
    }

    let result;
    try {
      result = await this.plugin.dictionary.lookup(hit.text, {
        signal: controller.signal,
        onRetry: () => {
          this.window.clearTimeout(active.loadingTimer);
          showLoading("card.retrying");
        },
      });
    } catch (error) {
      if (!this.checkActive(active)) return;
      const known = error instanceof LookupError;
      const message = t(known ? `error.${error.code}` : "error.generic");
      const retry = known && error.retry ? () => {
        if (this.checkActive(active)) this.open(hit);
      } : null;
      this.card.status(hit, message, "error", retry);
      return;
    } finally {
      this.window.clearTimeout(active.loadingTimer);
    }
    if (this.checkActive(active)) this.card.result(hit, result, this.plugin.settings.maxSenses);
  }

  checkActive(active) {
    if (this.active !== active) return false;
    const { hit } = active;
    if (hit.owner.isConnected && this.plugin.enabledFor(hit.path)) return true;
    this.close();
    return false;
  }

  clearHover() {
    this.window.clearTimeout(this.dwellTimer);
    this.cancelSelectionExit();
    this.pending = null;
    if (!this.ready) return;
    if (this.ready.kind === "selection") {
      this.selectionButton.hidden = true;
    } else {
      this.ready.owner.classList.remove("palimserest-hover-target");
      this.hoverLayer.replaceChildren();
    }
    this.ready = null;
  }

  cancelSelectionExit() {
    this.window.clearTimeout(this.selectionExitTimer);
    this.selectionExitTimer = undefined;
  }

  cancelFrame() {
    if (this.frame) this.window.cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  cancelLookup() {
    const active = this.active;
    if (!active) return;
    this.active = null;
    this.window.clearTimeout(active.loadingTimer);
    active.controller.abort();
  }

  close() {
    this.cancelLookup();
    this.card.hide();
  }

  resetHover(keepPress = false) {
    this.cancelFrame();
    this.clearHover();
    if (!keepPress) this.pressed = null;
    this.dismissedHit = null;
  }

  dismiss(keepPress = false) {
    this.resetHover(keepPress);
    this.close();
  }

  invalidate(matchesHit, layoutOnly = false) {
    const hovered = [this.pending, this.ready, this.pressed];
    if (hovered.some(hit => hit && matchesHit(hit))) this.resetHover(layoutOnly);
    if (!layoutOnly && this.active && matchesHit(this.active.hit)) this.close();
  }

  dispose() {
    this.events.abort();
    this.dismiss();
    this.hoverLayer.remove();
    this.selectionButton.remove();
    this.card.dispose();
  }
}

class LookupCard {
  constructor(document, t) {
    this.window = document.defaultView;
    this.t = t;
    this.element = addElement(document.body, "aside", "palimserest-lookup");
    this.element.hidden = true;
    this.element.setAttribute("aria-label", t("card.label"));
  }

  prepare(text, mode) {
    this.element.replaceChildren();
    this.element.dataset.mode = mode;
    const title = addElement(this.element, "strong", "palimserest-word", text);
    title.lang = "en";
  }

  status({ text, rect }, message, mode, retry) {
    this.prepare(text, mode);
    if (mode === "loading") {
      const skeleton = addElement(this.element, "div", "palimserest-skeleton");
      skeleton.setAttribute("aria-hidden", "true");
      for (let line = 0; line < 3; line++) addElement(skeleton, "span");
    }
    const status = addElement(this.element, "div", "palimserest-status", message);
    status.setAttribute("role", "status");
    if (retry) {
      const button = addElement(this.element, "button", "palimserest-retry", this.t("card.retry"));
      button.type = "button";
      button.addEventListener("click", retry);
    }
    this.show(rect);
  }

  result(hit, { source, groups }, maxSenses) {
    if (!groups.length) {
      const key = source === "sample" ? "card.sampleNoMatch" : "card.noMatch";
      this.status(hit, this.t(key), "empty");
      return;
    }
    const { text, rect } = hit;
    this.prepare(text, "result");
    const visible = limitSenses(groups, maxSenses);
    for (const group of visible) this.addGroup(text, group, source);
    const footer = addElement(this.element, "footer", "palimserest-source");
    if (source === "sample") {
      const hasAudio = visible.some(group => group.pronunciations.some(item => item.url));
      footer.textContent = this.t(hasAudio ? "card.sampleAudioSource" : "card.sampleSource");
    } else {
      addElement(footer, "span", "", LEARNERS_NAME);
      externalLink(footer, this.t("card.dictionaryLink"), "https://www.merriam-webster.com/dictionary/" + encodeURIComponent(groups[0].word));
    }
    this.show(rect);
  }

  addGroup(text, group, source) {
    const entry = addElement(this.element, "section", "palimserest-entry");
    entry.lang = "en";
    const heading = addElement(entry, "div", "palimserest-entry-heading");
    if (wordKey(group.word) !== wordKey(text)) addElement(heading, "span", "palimserest-lemma", group.word);
    if (group.part) addElement(heading, "span", "palimserest-part", group.part);
    const audioStatus = addElement(entry, "div", "palimserest-status");
    audioStatus.setAttribute("role", "status");
    audioStatus.hidden = true;

    for (const pronunciation of group.pronunciations) {
      const line = addElement(heading, "span", "palimserest-pronunciation");
      const form = wordKey(pronunciation.form) !== wordKey(group.word) ? pronunciation.form : "";
      if (form) addElement(line, "span", "", form);
      if (pronunciation.label) addElement(line, "span", "", pronunciation.label);
      if (pronunciation.ipa) addElement(line, "span", "", "/" + pronunciation.ipa + "/");
      if (!pronunciation.url) continue;
      const play = addElement(line, "button", "clickable-icon palimserest-play");
      play.type = "button";
      const pronunciationName = [pronunciation.form, group.part, pronunciation.label].filter(Boolean).join(" ");
      const label = this.t(source === "sample" ? "audio.playSample" : "audio.playDictionary", {
        pronunciation: pronunciationName,
      });
      play.setAttribute("aria-label", label);
      play.title = label;
      setIcon(play, "volume-2");
      play.addEventListener("click", () => this.play(pronunciation.url, play, audioStatus));
    }

    for (const definition of group.definitions) addElement(entry, "p", "palimserest-definition", definition);
  }

  play(url, button, status) {
    this.stopAudio();
    const audio = new this.window.Audio();
    const playback = { audio, button, status };
    this.playback = playback;
    this.setAudioLoading(button, true);
    const failed = () => {
      if (this.playback !== playback || !status.hidden) return;
      this.setAudioLoading(button, false);
      status.textContent = this.t("audio.failed");
      status.hidden = false;
    };
    audio.addEventListener("playing", () => {
      if (this.playback === playback) this.setAudioLoading(button, false);
    }, { once: true });
    audio.addEventListener("error", failed, { once: true });
    audio.src = url;
    audio.play().catch(failed);
  }

  setAudioLoading(button, loading) {
    if ((button.getAttribute("aria-busy") === "true") === loading) return;
    button.setAttribute("aria-busy", String(loading));
    button.title = loading ? this.t("audio.loading") : button.getAttribute("aria-label");
    setIcon(button, loading ? "loader-circle" : "volume-2");
  }

  stopAudio() {
    if (!this.playback) return;
    const { audio, button, status } = this.playback;
    this.playback = null;
    this.setAudioLoading(button, false);
    status.hidden = true;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }

  show({ left, top, bottom }) {
    const { element } = this;
    const margin = 8;
    const gap = 5;
    const height = this.window.innerHeight;
    const topEdge = Math.max(margin, bottom + gap);
    const bottomEdge = Math.max(margin, height - top + gap);
    element.style.maxHeight = "";
    element.hidden = false;
    const below = height - topEdge - margin;
    const above = height - bottomEdge - margin;
    const openBelow = below >= element.offsetHeight || below >= above;
    element.style.maxHeight = Math.max(0, openBelow ? below : above) + "px";
    element.style.top = openBelow ? topEdge + "px" : "";
    element.style.bottom = openBelow ? "" : bottomEdge + "px";
    const maxLeft = this.window.innerWidth - element.offsetWidth - margin;
    element.style.left = Math.max(margin, Math.min(left, maxLeft)) + "px";
  }

  hide() {
    this.element.hidden = true;
    this.element.replaceChildren();
  }

  dispose() {
    this.stopAudio();
    this.element.remove();
  }
}

class PalimserestSettings extends PluginSettingTab {
  constructor(plugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl, plugin } = this;
    const { t } = plugin;
    containerEl.replaceChildren();
    addElement(containerEl, "p", "", t("settings.intro", { property: NOTE_PROPERTY }));
    const requests = new Setting(containerEl)
      .setName(t("settings.requests.label"))
      .setDesc(t("settings.requests.description"));
    this.requestCountEl = addElement(requests.controlEl, "span", "");
    this.refreshRequestCount();

    const source = new Setting(containerEl)
      .setName(t("settings.provider.label"))
      .setDesc(t("settings.provider.description"))
      .addDropdown(dropdown => dropdown
        .addOption("sample", t("settings.provider.sample"))
        .addOption("learners", LEARNERS_NAME)
        .setValue(plugin.settings.provider)
        .onChange(async provider => {
          await plugin.saveSetting("provider", provider);
          this.display();
        }));
    source.descEl.append(" ");
    externalLink(source.descEl, t("settings.provider.terms"), "https://dictionaryapi.com/info/terms-of-service");

    if (plugin.settings.provider === "learners") {
      new Setting(containerEl)
        .setName(t("settings.secret.label"))
        .setDesc(t("settings.secret.description"))
        .addComponent(element => new SecretComponent(plugin.app, element)
          .setValue(plugin.settings.secretName)
          .onChange(name => plugin.saveSetting("secretName", name ?? "")));
      const attribution = externalLink(containerEl, "", "https://www.merriam-webster.com/");
      const logo = addElement(attribution, "img");
      logo.alt = "Merriam-Webster";
      logo.width = 50;
      logo.height = 50;
      logo.src = "https://dictionaryapi.com/images/info/branding-guidelines/MWLogo_LightBG_120x120_2x.png";
    }

    new Setting(containerEl).setName(t("settings.lookupHeading")).setHeading();
    new Setting(containerEl)
      .setName(t("settings.hoverStyle.label"))
      .setDesc(t("settings.hoverStyle.description"))
      .addDropdown(dropdown => {
        for (const style of HOVER_STYLES) {
          dropdown.addOption(style, t("settings.hoverStyle." + style));
        }
        dropdown
          .setValue(plugin.settings.hoverStyle)
          .onChange(style => plugin.saveSetting("hoverStyle", style));
      });

    for (const [name, { defaultValue, min, max }] of Object.entries(NUMBER_SETTINGS)) {
      const label = t(`settings.${name}.label`);
      const description = t(`settings.${name}.description`);
      new Setting(containerEl)
        .setName(label)
        .setDesc(t("settings.numberDescription", { description, defaultValue, min, max }))
        .addText(text => {
          const input = text.inputEl;
          input.type = "number";
          input.min = String(min);
          input.max = String(max);
          input.step = "1";
          input.required = true;
          input.setAttribute("aria-label", label);
          text.setValue(String(plugin.settings[name]));
          // Commit the finished value so typing a new limit cannot evict entries mid-edit.
          input.addEventListener("change", async () => {
            if (input.validity.valid) await plugin.saveSetting(name, input.valueAsNumber);
            else input.value = String(plugin.settings[name]);
          });
        });
    }
  }

  refreshRequestCount() {
    if (this.requestCountEl) this.requestCountEl.textContent = String(this.plugin.dictionary.todayRequestCount);
  }

  hide() {
    this.requestCountEl = null;
  }
}

module.exports = class Palimserest extends Plugin {
  async onload() {
    const [stored, t] = await Promise.all([
      this.loadData(),
      loadTranslator(this.app.vault.adapter, this.pluginDirectory, getLanguage()),
    ]);
    this.t = t;
    this.settings = {
      provider: stored?.provider === "learners" ? "learners" : "sample",
      secretName: typeof stored?.secretName === "string" ? stored.secretName : "",
      hoverStyle: HOVER_STYLES.includes(stored?.hoverStyle) ? stored.hoverStyle : HOVER_STYLES[0],
    };
    for (const [name, { defaultValue, min, max }] of Object.entries(NUMBER_SETTINGS)) {
      const value = stored?.[name];
      this.settings[name] = Number.isSafeInteger(value) && value >= min && value <= max ? value : defaultValue;
    }
    this.dictionary = new Dictionary(this, () => this.settingsTab?.refreshRequestCount());
    this.sections = new WeakMap();
    this.editors = new WeakMap();
    this.interactions = new Map();
    this.settingsTab = new PalimserestSettings(this);
    this.addSettingTab(this.settingsTab);
    this.registerInterval(window.setInterval(() => {
      this.settingsTab.refreshRequestCount();
      this.dictionary.pruneCache();
    }, 60_000));

    this.registerMarkdownPostProcessor((element, context) => {
      this.sections.set(element, context.sourcePath);
      this.interactionFor(element.ownerDocument);
    });

    const plugin = this;
    this.registerEditorExtension(ViewPlugin.fromClass(class {
      constructor(view) {
        this.view = view;
        plugin.editors.set(view.dom, view);
        plugin.interactionFor(view.dom.ownerDocument);
      }

      update(update) {
        const modeChanged = update.startState.field(editorLivePreviewField, false) !==
          update.state.field(editorLivePreviewField, false);
        const contentChanged = update.docChanged || modeChanged;
        if (contentChanged || update.selectionSet || update.viewportChanged) {
          // A click can move the caret before the click event reaches the document.
          const { dom } = this.view;
          plugin.interactions.get(dom.ownerDocument)?.invalidate(hit => hit.owner === dom, !contentChanged);
        }
      }

      destroy() {
        const { dom } = this.view;
        plugin.editors.delete(dom);
        plugin.interactions.get(dom.ownerDocument)?.invalidate(hit => hit.owner === dom);
      }
    }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.dismissLookups(true)));
    this.registerEvent(this.app.workspace.on("file-open", () => this.dismissLookups(true)));
    this.registerEvent(this.app.metadataCache.on("changed", file => {
      if (this.enabledFor(file.path)) return;
      for (const interaction of this.interactions.values()) interaction.invalidate(hit => hit.path === file.path);
    }));
    this.registerEvent(this.app.workspace.on("window-close", (_, win) => {
      this.interactions.get(win.document)?.dispose();
      this.interactions.delete(win.document);
    }));
  }

  onunload() {
    for (const interaction of this.interactions?.values() ?? []) interaction.dispose();
    this.interactions?.clear();
    this.dictionary?.invalidateRequests();
  }

  async saveSetting(name, value) {
    if (this.settings[name] === value) return;
    const settings = { ...this.settings, [name]: value };
    this.settings = settings;
    if (name === "provider" || name === "secretName") this.dictionary.invalidateRequests();
    if (name === "cacheLimit" || name === "cacheMaxAgeHours") this.dictionary.pruneCache();
    this.dismissLookups();
    this.settingsSave = (this.settingsSave ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.saveData(settings));
    await this.settingsSave;
  }

  dismissLookups(keepPress = false) {
    for (const interaction of this.interactions.values()) interaction.dismiss(keepPress);
  }

  interactionFor(document) {
    if (!this.interactions.has(document)) this.interactions.set(document, new LookupInteraction(this, document));
    return this.interactions.get(document);
  }

  enabledFor(path) {
    return Boolean(path) && this.app.metadataCache.getCache(path)?.frontmatter?.[NOTE_PROPERTY] === true;
  }

  get pluginDirectory() {
    return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }

  exampleAudio(clip) {
    return this.app.vault.adapter.getResourcePath(`${this.pluginDirectory}/demo-audio/${clip}.wav`);
  }

  hitAt(target, x, y, selection) {
    if (target.closest(SKIP_RENDERED)) return null;
    const editor = this.editors.get(target.closest(".cm-editor"));
    const focused = this.editors.get(target.ownerDocument.activeElement?.closest(".cm-editor"));
    const selectedEditor = [focused, editor].find(view => view?.state.selection.ranges.some(range => !range.empty));
    if (selectedEditor || selection) {
      if (selectedEditor && !selectedEditor.contentDOM.contains(target)) return null;
      if (!selectedEditor && !target.closest(".markdown-reading-view")?.contains(selection.anchorNode)) return null;
      const hit = selectedEditor ? this.editorSelection(selectedEditor) : this.readingSelection(selection);
      if (!hit?.owner.contains(target)) return null;
      const rect = hit.rects.find(rect => containsPoint(rect, x, y));
      return rect ? { ...hit, rect } : null;
    }

    const hit = editor ? this.editorHit(editor, target, x, y) : this.readingHit(target, x, y);
    if (hit && this.settings.provider === "sample" && !Object.hasOwn(EXAMPLES, wordKey(hit.text))) return null;
    return hit ? { ...hit, kind: "word" } : null;
  }

  readingContext(target) {
    const reading = target?.closest(".markdown-reading-view");
    if (!reading || !target.closest(READING_TEXT)) return null;
    let owner = target;
    while (owner !== reading && !this.sections.has(owner)) owner = owner.parentElement;
    const path = this.sections.get(owner);
    return this.enabledFor(path) ? { owner, path, reading } : null;
  }

  readingHit(target, x, y) {
    const context = this.readingContext(target);
    if (!context) return null;
    const { owner, path } = context;

    const document = owner.ownerDocument;
    const caret = document.caretPositionFromPoint?.(x, y);
    const fallback = caret ? null : document.caretRangeFromPoint?.(x, y);
    const node = caret?.offsetNode ?? fallback?.startContainer;
    const offset = caret?.offset ?? fallback?.startOffset;
    if (node?.nodeType !== 3 || !owner.contains(node) || node.parentElement.closest(SKIP_RENDERED)) return null;
    const word = wordAt(node.data, offset, this.settings.maxWordLength);
    if (!word) return null;
    const range = document.createRange();
    range.setStart(node, word.from);
    range.setEnd(node, word.to);
    const rect = rectAt(range, x, y);
    return rect ? { owner, path, text: word.text, range, rect } : null;
  }

  editorPath(view) {
    if (!view.state.field(editorLivePreviewField, false)) return null;
    const path = view.state.field(editorInfoField, false)?.file?.path;
    return this.enabledFor(path) ? path : null;
  }

  editorHit(view, target, x, y) {
    if (!view.contentDOM.contains(target) || target.closest(SKIP_EDITOR)) return null;
    const path = this.editorPath(view);
    if (!path) return null;
    const position = view.posAtCoords({ x, y });
    if (position === null) return null;
    const line = view.state.doc.lineAt(position);
    const word = wordAt(line.text, position - line.from, this.settings.maxWordLength);
    if (!word) return null;

    const editorFrom = line.from + word.from;
    const editorTo = line.from + word.to;
    const range = editorDOMRange(view, editorFrom, editorTo);
    const rect = rectAt(range, x, y);
    return rect ? { owner: view.dom, path, text: word.text, editorFrom, editorTo, range, rect } : null;
  }

  selectionFor(hit) {
    if (!hit.owner.isConnected) return null;
    const editor = this.editors.get(hit.owner);
    return editor ? this.editorSelection(editor) : this.readingSelection(hit.owner.ownerDocument.getSelection());
  }

  readingSelection(selection) {
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
    const range = selection.getRangeAt(0);
    const start = range.startContainer;
    const end = range.endContainer;
    const from = this.readingContext(start.nodeType === 1 ? start : start.parentElement);
    const to = this.readingContext(end.nodeType === 1 ? end : end.parentElement);
    if (!from || !to || from.reading !== to.reading || from.path !== to.path) return null;

    const source = selection.toString();
    if (source.length > this.settings.maxSelectionLength) return null;
    const text = source.trim();
    if (!text) return null;
    const rects = selectionRects(range, SKIP_RENDERED);
    if (!rects.length) return null;
    const owner = from.owner === to.owner ? from.owner : from.reading;
    return { kind: "selection", owner, path: from.path, text, range: range.cloneRange(), rects };
  }

  editorSelection(view) {
    const { main, ranges } = view.state.selection;
    if (ranges.length !== 1 || main.empty || main.to - main.from > this.settings.maxSelectionLength) return null;
    const path = this.editorPath(view);
    if (!path || !view.visibleRanges.some(range => range.from <= main.from && range.to >= main.to)) return null;

    const source = view.state.sliceDoc(main.from, main.to);
    const text = source.trim();
    if (!text) return null;
    const range = editorDOMRange(view, main.from, main.to);
    // A folded or replaced part of the selection can have no matching text in the editor DOM.
    if (range.toString() !== source.replace(/\r?\n/g, "")) return null;
    const rects = selectionRects(range, SKIP_EDITOR_SELECTION);
    if (!rects.length) return null;
    return { kind: "selection", owner: view.dom, path, text, editorFrom: main.from, editorTo: main.to, range, rects };
  }
};
