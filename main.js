"use strict";

const {
  Plugin,
  PluginSettingTab,
  SecretComponent,
  Setting,
  editorInfoField,
  editorLivePreviewField,
  requestUrl,
  setIcon,
} = require("obsidian");
const { ViewPlugin } = require("@codemirror/view");

const NOTE_PROPERTY = "english-hover";
const HOVER_HIGHLIGHT = "palimserest-hover-word";
const LEARNERS_NAME = "Merriam-Webster's Learner's Dictionary with Audio";
const LEARNERS_ENDPOINT = "https://www.dictionaryapi.com/api/v3/references/learners/json/";
const LEARNERS_AUDIO_BASE = "https://media.merriam-webster.com/audio/prons/en/us/mp3/";
const LOOKUP_CACHE_KEY = "palimserest-learners-cache-v1";
const HOUR_MS = 60 * 60 * 1000;
const LEGACY_CACHE_HOURS = 7 * 24;
const LEGACY_MAX_SENSES = 3;
const REQUEST_COUNT_KEY = "palimserest-daily-requests";
const ENGLISH_WORD = /\p{Script=Latin}[\p{Script=Latin}\p{M}]*(?:['’ʼ\-‐‑]\p{Script=Latin}[\p{Script=Latin}\p{M}]*)*/gu;

const NUMBER_SETTINGS = {
  hoverDelay: {
    label: "悬停时长（毫秒）",
    description: "鼠标停留多久后高亮单词并允许点击查词。",
    defaultValue: 300, min: 0, max: 10_000,
  },
  maxSenses: {
    label: "卡片释义上限",
    description: "一次查词最多显示的释义条数。",
    defaultValue: LEGACY_MAX_SENSES, min: 1, max: 30,
  },
  maxWordLength: {
    label: "单词长度上限",
    description: "超过此长度的单词会跳过。",
    defaultValue: 80, min: 1, max: 256,
  },
  loadingDelay: {
    label: "加载提示延迟（毫秒）",
    description: "点击查词后，查询等待超过此时长才显示「查询中」。",
    defaultValue: 180, min: 0, max: 10_000,
  },
  leaveDelay: {
    label: "卡片关闭延迟（毫秒）",
    description: "鼠标离开单词或卡片后，卡片收起前的等待时间。",
    defaultValue: 220, min: 0, max: 10_000,
  },
  requestTimeout: {
    label: "联网查询超时（毫秒）",
    description: "等待词典响应的最长时间。",
    defaultValue: 2500, min: 100, max: 60_000,
  },
  cacheLimit: {
    label: "缓存词条上限",
    description: "本库最多保存的联网查询结果数。填 0 可关闭缓存。",
    defaultValue: 512, min: 0, max: 4096,
  },
  cacheMaxAgeHours: {
    label: "缓存有效期（小时）",
    description: "从查询完成起计算，超期后重新查询。填 0 可关闭缓存。",
    defaultValue: LEGACY_CACHE_HOURS, min: 0, max: 8760,
  },
};

const SKIP_RENDERED = "a, code, pre, .math, mjx-container, .internal-embed, .markdown-embed, .metadata-container, .footnote-ref, img, svg";
const SKIP_EDITOR = [
  ".cm-formatting", ".cm-link", ".cm-url", ".cm-hmd-internal-link",
  ".cm-hmd-barelink", ".cm-hmd-footnote", ".cm-inline-code", ".cm-math",
  ".HyperMD-codeblock", ".HyperMD-frontmatter", ".HyperMD-math",
].join(", ");

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
};

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

function rectAt(range, x, y) {
  return Array.from(range.getClientRects()).find(rect =>
    rect.width > 0 && x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom
  );
}

function sameWord(a, b) {
  if (!a || !b || a.owner !== b.owner || a.path !== b.path || a.text !== b.text) return false;
  // Live Preview can rebuild its text nodes when a click moves the caret.
  if (a.editorOffset !== undefined) return a.editorOffset === b.editorOffset;
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
  constructor(message, retry = false) {
    super(message);
    this.retry = retry;
  }
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
  constructor(plugin) {
    this.plugin = plugin;
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
    this.plugin.settingsTab?.refreshRequestCount();
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

  async lookup(text) {
    const query = spelling(text);
    if (this.plugin.settings.provider !== "learners") {
      const samples = Object.hasOwn(EXAMPLES, wordKey(query)) ? EXAMPLES[wordKey(query)] : [];
      return {
        source: "sample",
        groups: samples.map(([word, part, definition, ipa, clip]) => ({
          word,
          part,
          definitions: [definition],
          pronunciations: [{
            form: clip === "ran" ? "ran" : word,
            ipa,
            url: this.plugin.exampleAudio(clip),
            label: "",
          }],
        })),
      };
    }

    const secretName = this.plugin.settings.secretName;
    const key = secretName && this.plugin.app.secretStorage.getSecret(secretName)?.trim();
    if (!key) throw new LookupError("请在 Palimserest 设置里选择 API Key。");
    const cached = this.cachedLookup(query);
    if (cached) return cached;
    const existing = this.inFlight.get(query);
    if (existing) return existing;

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = window.setTimeout(() => reject(new LookupError("查询超时。", true)), this.plugin.settings.requestTimeout);
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

  async fetch(query, key) {
    let response;
    try {
      const url = LEARNERS_ENDPOINT + encodeURIComponent(query) + "?key=" + encodeURIComponent(key);
      this.recordRequest();
      response = await requestUrl({ url, throw: false });
    } catch {
      throw new LookupError("连接词典失败。", true);
    }
    if (response.status === 401 || response.status === 403) {
      throw new LookupError("词典拒绝请求，请检查 API Key。");
    }
    if (response.status === 429) throw new LookupError("词典请求达到限额，请稍后再试。");
    if (response.status === 404) return { source: "learners", groups: [] };
    if (response.status >= 400) throw new LookupError("词典暂时无法响应。", response.status >= 500);

    let payload;
    try {
      payload = response.json;
    } catch {
      throw new LookupError("词典返回了无法读取的内容。", true);
    }
    if (typeof payload === "string" && /(?:api key|not authorized|access denied)/i.test(payload)) {
      throw new LookupError("词典拒绝请求，请检查 API Key。");
    }
    if (!Array.isArray(payload)) throw new LookupError("词典返回了无法读取的内容。", true);
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

class HoverCard {
  constructor(plugin, document) {
    this.plugin = plugin;
    this.document = document;
    this.window = document.defaultView;
    this.events = new this.window.AbortController();
    this.card = addElement(document.body, "aside", "palimserest-lookup");
    this.card.hidden = true;
    this.card.setAttribute("aria-label", "单词查词");

    const listen = (target, event, callback, options) => {
      target.addEventListener(event, callback, { ...options, signal: this.events.signal });
    };
    listen(document, "pointermove", event => this.pointerMove(event), { passive: true });
    listen(document, "pointerdown", event => this.pointerDown(event), { capture: true });
    listen(document, "pointercancel", () => this.dismiss());
    listen(document, "click", event => this.click(event), { capture: true });
    listen(document, "pointerout", event => {
      if (!event.relatedTarget) this.dismiss();
    });
    listen(document, "scroll", event => {
      if (!this.card.contains(event.target)) this.dismiss();
    }, { capture: true, passive: true });
    listen(document, "selectionchange", () => {
      if (this.hasSelection()) this.dismiss();
    });
    listen(document, "keydown", event => {
      if (event.key !== "Escape") return;
      const hit = this.pending ?? this.ready ?? this.pressed ?? this.active?.hit;
      this.dismiss();
      this.dismissedHit = hit;
    });
    listen(this.card, "pointerenter", () => {
      this.cancelFrame();
      this.clearHover();
      this.cancelLeave();
    });
    listen(this.card, "pointerleave", () => this.leave());
    listen(this.card, "focusout", event => {
      if (!this.card.contains(event.relatedTarget) && !this.card.matches(":hover")) this.leave();
    });
    listen(this.window, "blur", () => this.dismiss());
    listen(this.window, "resize", () => this.dismiss());
  }

  pointerMove(event) {
    if (event.pointerType === "touch") return;
    const moved = event.clientX !== this.pointer?.clientX || event.clientY !== this.pointer?.clientY;
    this.pointer = event;
    if (this.card.contains(event.target)) return;
    if (this.hasSelection()) {
      this.dismiss();
      return;
    }
    if (event.buttons) {
      if (!this.pressed || !sameWord(this.pressed, this.hitAtPointer(event))) this.dismiss();
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
    if (this.card.contains(event.target)) return;
    let pressed = null;
    if (this.ready && event.button === 0 && event.pointerType !== "touch" &&
        !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !this.hasSelection()) {
      const hit = this.hitAtPointer(event);
      if (sameWord(hit, this.ready)) pressed = hit;
    }
    this.dismiss();
    this.pressed = pressed;
  }

  click(event) {
    const pressed = this.pressed;
    this.pressed = null;
    if (!pressed || event.button !== 0 || event.detail === 0 || event.defaultPrevented || this.hasSelection()) return;
    const hit = this.hitAtPointer(event);
    if (sameWord(hit, pressed)) this.open(hit);
  }

  hitAtPointer({ clientX, clientY }) {
    const target = this.document.elementFromPoint(clientX, clientY);
    return target && !this.card.contains(target) ? this.plugin.hitAt(target, clientX, clientY) : null;
  }

  hasSelection() {
    const selection = this.document.getSelection();
    return selection && !selection.isCollapsed && !this.card.contains(selection.anchorNode);
  }

  track(hit) {
    if (sameWord(hit, this.dismissedHit)) return;
    this.dismissedHit = null;
    if (sameWord(hit, this.active?.hit)) {
      this.clearHover();
      this.cancelLeave();
      return;
    }
    if (this.active) {
      if (this.card.hidden || (hit && this.card.dataset.mode === "loading")) this.close();
      else this.leave();
    }
    if (sameWord(hit, this.pending) || sameWord(hit, this.ready)) return;
    this.clearHover();
    if (!hit) return;
    this.pending = hit;
    this.dwellTimer = this.window.setTimeout(() => {
      this.pending = null;
      if (this.hasSelection()) return;
      const current = this.hitAtPointer(this.pointer);
      if (!sameWord(hit, current)) return;
      this.ready = current;
      current.owner.classList.add("palimserest-hover-target");
      this.window.CSS?.highlights?.set(HOVER_HIGHLIGHT, new this.window.Highlight(current.range));
    }, this.plugin.settings.hoverDelay);
  }

  valid(hit) {
    return hit.owner.isConnected && hit.range.startContainer.isConnected && this.plugin.enabledFor(hit.path);
  }

  open(hit) {
    this.close();
    const active = { hit };
    this.active = active;
    this.loadingTimer = this.window.setTimeout(() => {
      if (this.active === active && this.valid(hit)) this.status(hit, "查询中…", "loading");
    }, this.plugin.settings.loadingDelay);
    this.plugin.dictionary.lookup(hit.text).then(result => {
      if (this.active !== active) return;
      this.window.clearTimeout(this.loadingTimer);
      if (!this.valid(hit)) this.close();
      else this.result(hit, result);
    }, error => {
      if (this.active !== active) return;
      this.window.clearTimeout(this.loadingTimer);
      if (!this.valid(hit)) {
        this.close();
        return;
      }
      const known = error instanceof LookupError;
      this.status(hit, known ? error.message : "查词失败。", "error",
        known && error.retry ? () => this.open(hit) : null);
    });
  }

  prepare(hit, mode) {
    this.card.replaceChildren();
    this.card.dataset.mode = mode;
    const title = addElement(this.card, "strong", "palimserest-word", hit.text);
    title.lang = "en";
  }

  status(hit, message, mode, retry) {
    this.prepare(hit, mode);
    const status = addElement(this.card, "div", "palimserest-status", message);
    status.setAttribute("role", "status");
    if (retry) {
      const button = addElement(this.card, "button", "palimserest-retry", "重试");
      button.type = "button";
      button.addEventListener("click", retry);
    }
    this.show(hit);
  }

  result(hit, { source, groups }) {
    if (!groups.length) {
      this.status(hit, source === "sample"
        ? "内置样例包含 subtle、yield、record、ran 和 run。"
        : "词典暂无匹配词条。", "empty");
      return;
    }
    this.prepare(hit, "result");
    for (const group of limitSenses(groups, this.plugin.settings.maxSenses)) this.addGroup(hit, group, source);
    const footer = addElement(this.card, "footer", "palimserest-source");
    if (source === "sample") footer.textContent = "内置样例 · 合成发音";
    else {
      addElement(footer, "span", "", LEARNERS_NAME);
      externalLink(footer, "查阅词条", "https://www.merriam-webster.com/dictionary/" + encodeURIComponent(groups[0].word));
    }
    this.show(hit);
  }

  addGroup(hit, group, source) {
    const entry = addElement(this.card, "section", "palimserest-entry");
    entry.lang = "en";
    const heading = addElement(entry, "div", "palimserest-entry-heading");
    if (wordKey(group.word) !== wordKey(hit.text)) addElement(heading, "span", "palimserest-lemma", group.word);
    if (group.part) addElement(heading, "span", "palimserest-part", group.part);
    const playback = addElement(entry, "div", "palimserest-status");
    playback.setAttribute("role", "status");
    playback.hidden = true;

    for (const pronunciation of group.pronunciations) {
      const line = addElement(heading, "span", "palimserest-pronunciation");
      const form = wordKey(pronunciation.form) !== wordKey(group.word) ? pronunciation.form : "";
      if (form) addElement(line, "span", "", form);
      if (pronunciation.label) addElement(line, "span", "", pronunciation.label);
      if (pronunciation.ipa) addElement(line, "span", "", "/" + pronunciation.ipa + "/");
      if (!pronunciation.url) continue;
      const play = addElement(line, "button", "clickable-icon palimserest-play");
      play.type = "button";
      const label = (source === "sample" ? "试听样例" : "播放词典录音") + " " +
        [pronunciation.form, group.part, pronunciation.label].filter(Boolean).join(" ");
      play.setAttribute("aria-label", label);
      play.title = label;
      setIcon(play, "volume-2");
      play.addEventListener("click", () => this.play(pronunciation.url, playback));
    }

    for (const definition of group.definitions) addElement(entry, "p", "palimserest-definition", definition);
  }

  play(url, status) {
    this.stopAudio();
    const audio = new this.window.Audio();
    this.audio = audio;
    this.audioStatus = status;
    status.textContent = "正在加载音频…";
    status.hidden = false;
    const failed = () => {
      if (this.audio !== audio) return;
      status.textContent = "音频加载失败，可以再次点播。";
      status.hidden = false;
    };
    audio.addEventListener("playing", () => {
      if (this.audio === audio) status.hidden = true;
    });
    audio.addEventListener("error", failed, { once: true });
    audio.src = url;
    audio.play().catch(failed);
  }

  stopAudio() {
    if (!this.audio) return;
    const audio = this.audio;
    this.audio = null;
    this.audioStatus.hidden = true;
    this.audioStatus = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }

  show(hit) {
    const { left, top, bottom } = hit.rect;
    const margin = 8;
    const gap = 5;
    this.card.style.maxHeight = "";
    this.card.hidden = false;
    const below = this.window.innerHeight - bottom - gap - margin;
    const above = top - gap - margin;
    const openBelow = below >= this.card.offsetHeight || below >= above;
    this.card.style.maxHeight = Math.max(0, openBelow ? below : above) + "px";
    this.card.style.top = openBelow ? bottom + gap + "px" : "";
    this.card.style.bottom = openBelow ? "" : this.window.innerHeight - top + gap + "px";
    const maxLeft = this.window.innerWidth - this.card.offsetWidth - margin;
    this.card.style.left = Math.max(margin, Math.min(left, maxLeft)) + "px";
  }

  leave() {
    if (this.leaveTimer) return;
    this.leaveTimer = this.window.setTimeout(() => {
      this.leaveTimer = 0;
      if (!this.card.matches(":hover") && !this.card.querySelector(":focus-visible")) this.close();
    }, this.plugin.settings.leaveDelay);
  }

  clearHover() {
    this.window.clearTimeout(this.dwellTimer);
    this.pending = null;
    if (!this.ready) return;
    this.ready.owner.classList.remove("palimserest-hover-target");
    this.window.CSS?.highlights?.delete(HOVER_HIGHLIGHT);
    this.ready = null;
  }

  cancelLeave() {
    this.window.clearTimeout(this.leaveTimer);
    this.leaveTimer = 0;
  }

  cancelFrame() {
    if (this.frame) this.window.cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  close() {
    this.active = null;
    this.cancelLeave();
    this.window.clearTimeout(this.loadingTimer);
    this.card.hidden = true;
    this.card.replaceChildren();
  }

  dismiss(keepPress = false) {
    this.cancelFrame();
    this.clearHover();
    this.close();
    if (!keepPress) this.pressed = null;
    this.dismissedHit = null;
  }

  invalidate(owner, keepPress = false) {
    if (this.pending?.owner === owner || this.ready?.owner === owner ||
        this.pressed?.owner === owner || this.active?.hit.owner === owner) this.dismiss(keepPress);
  }

  dispose() {
    this.events.abort();
    this.dismiss();
    this.stopAudio();
    this.card.remove();
  }
}

class PalimserestSettings extends PluginSettingTab {
  constructor(plugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl, plugin } = this;
    containerEl.replaceChildren();
    addElement(containerEl, "p", "", "在摘抄笔记的属性里将 english-hover 设为 true。悬停至单词高亮后，点击查词。");
    const requests = new Setting(containerEl)
      .setName("今日词典请求次数")
      .setDesc("按本机日期统计本库实际发出的联网查词请求。缓存命中、离线样例和录音点播不计入。");
    this.requestCountEl = addElement(requests.controlEl, "span", "");
    this.refreshRequestCount();

    const source = new Setting(containerEl)
      .setName("词典来源")
      .setDesc("内置样例可离线试用。得到词典方的使用许可后，选择 Merriam-Webster。")
      .addDropdown(dropdown => dropdown
        .addOption("sample", "内置样例")
        .addOption("learners", LEARNERS_NAME)
        .setValue(plugin.settings.provider)
        .onChange(async provider => {
          await plugin.saveSetting("provider", provider);
          this.display();
        }));
    source.descEl.append(" ");
    externalLink(source.descEl, "API 条款", "https://dictionaryapi.com/info/terms-of-service");

    if (plugin.settings.provider === "learners") {
      new Setting(containerEl)
        .setName("Learner’s Dictionary API Key")
        .setDesc("从 Obsidian 的密钥存储选择个人 Key。查词时会把单词和 Key 发送给 Merriam-Webster。")
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

    new Setting(containerEl).setName("查词与缓存").setHeading();
    for (const [name, { label, description, defaultValue, min, max }] of Object.entries(NUMBER_SETTINGS)) {
      new Setting(containerEl)
        .setName(label)
        .setDesc(`${description} 默认 ${defaultValue}，范围 ${min}–${max}。`)
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
    const stored = await this.loadData();
    this.settings = {
      provider: stored?.provider === "learners" ? "learners" : "sample",
      secretName: typeof stored?.secretName === "string" ? stored.secretName : "",
    };
    for (const [name, { defaultValue, min, max }] of Object.entries(NUMBER_SETTINGS)) {
      const value = stored?.[name];
      this.settings[name] = Number.isSafeInteger(value) && value >= min && value <= max ? value : defaultValue;
    }
    this.dictionary = new Dictionary(this);
    this.sections = new WeakMap();
    this.editors = new WeakMap();
    this.cards = new Map();
    this.settingsTab = new PalimserestSettings(this);
    this.addSettingTab(this.settingsTab);
    this.registerInterval(window.setInterval(() => {
      this.settingsTab.refreshRequestCount();
      this.dictionary.pruneCache();
    }, 60_000));

    this.registerMarkdownPostProcessor((element, context) => {
      this.sections.set(element, context.sourcePath);
      this.cardFor(element.ownerDocument);
    });

    const plugin = this;
    this.registerEditorExtension(ViewPlugin.fromClass(class {
      constructor(view) {
        this.view = view;
        plugin.editors.set(view.dom, view);
        plugin.cardFor(view.dom.ownerDocument);
      }

      update(update) {
        const modeChanged = update.startState.field(editorLivePreviewField, false) !==
          update.state.field(editorLivePreviewField, false);
        const contentChanged = update.docChanged || modeChanged;
        if (contentChanged || update.selectionSet || update.viewportChanged) {
          // A click can move the caret before the click event reaches the document.
          plugin.cards.get(this.view.dom.ownerDocument)?.invalidate(this.view.dom, !contentChanged);
        }
      }

      destroy() {
        plugin.editors.delete(this.view.dom);
        plugin.cards.get(this.view.dom.ownerDocument)?.invalidate(this.view.dom);
      }
    }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.dismissCards(true)));
    this.registerEvent(this.app.workspace.on("file-open", () => this.dismissCards(true)));
    this.registerEvent(this.app.metadataCache.on("changed", file => {
      if (this.enabledFor(file.path)) return;
      for (const card of this.cards.values()) {
        if (card.pending?.path === file.path || card.ready?.path === file.path ||
            card.pressed?.path === file.path || card.active?.hit.path === file.path) card.dismiss();
      }
    }));
    this.registerEvent(this.app.workspace.on("window-close", (_, win) => {
      this.cards.get(win.document)?.dispose();
      this.cards.delete(win.document);
    }));
  }

  onunload() {
    this.dictionary?.inFlight.clear();
    for (const card of this.cards?.values() ?? []) card.dispose();
    this.cards?.clear();
  }

  async saveSetting(name, value) {
    if (this.settings[name] === value) return;
    const settings = { ...this.settings, [name]: value };
    this.settings = settings;
    if (name === "provider" || name === "secretName") this.dictionary.inFlight.clear();
    if (name === "cacheLimit" || name === "cacheMaxAgeHours") this.dictionary.pruneCache();
    this.dismissCards();
    this.settingsSave = (this.settingsSave ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.saveData(settings));
    await this.settingsSave;
  }

  dismissCards(keepPress = false) {
    for (const card of this.cards.values()) card.dismiss(keepPress);
  }

  cardFor(document) {
    if (!this.cards.has(document)) this.cards.set(document, new HoverCard(this, document));
    return this.cards.get(document);
  }

  enabledFor(path) {
    return Boolean(path) && this.app.metadataCache.getCache(path)?.frontmatter?.[NOTE_PROPERTY] === true;
  }

  exampleAudio(clip) {
    const folder = this.manifest.dir ?? this.app.vault.configDir + "/plugins/" + this.manifest.id;
    return this.app.vault.adapter.getResourcePath(folder + "/demo-audio/" + clip + ".wav");
  }

  hitAt(target, x, y) {
    if (target.closest(SKIP_RENDERED)) return null;
    const editor = this.editors.get(target.closest(".cm-editor"));
    const hit = editor ? this.editorHit(editor, target, x, y) : this.readingHit(target, x, y);
    if (hit && this.settings.provider === "sample" && !Object.hasOwn(EXAMPLES, wordKey(hit.text))) return null;
    return hit;
  }

  readingHit(target, x, y) {
    const reading = target.closest(".markdown-reading-view");
    if (!reading || !target.closest("p, li, blockquote, h1, h2, h3, h4, h5, h6")) return null;
    let section = target;
    while (section && !this.sections.has(section) && section !== reading) section = section.parentElement;
    const path = this.sections.get(section);
    if (!this.enabledFor(path)) return null;

    const document = section.ownerDocument;
    const caret = document.caretPositionFromPoint?.(x, y);
    const fallback = caret ? null : document.caretRangeFromPoint?.(x, y);
    const node = caret?.offsetNode ?? fallback?.startContainer;
    const offset = caret?.offset ?? fallback?.startOffset;
    if (node?.nodeType !== 3 || !section.contains(node) || node.parentElement.closest(SKIP_RENDERED)) return null;
    const word = wordAt(node.data, offset, this.settings.maxWordLength);
    if (!word) return null;
    const range = document.createRange();
    range.setStart(node, word.from);
    range.setEnd(node, word.to);
    const rect = rectAt(range, x, y);
    return rect ? { owner: section, path, text: word.text, range, rect } : null;
  }

  editorHit(view, target, x, y) {
    if (!view.contentDOM.contains(target) || !view.state.field(editorLivePreviewField, false) ||
        target.closest(SKIP_EDITOR) || view.state.selection.ranges.some(range => !range.empty)) return null;
    const path = view.state.field(editorInfoField, false)?.file?.path;
    if (!this.enabledFor(path)) return null;
    const position = view.posAtCoords({ x, y });
    if (position === null) return null;
    const line = view.state.doc.lineAt(position);
    const word = wordAt(line.text, position - line.from, this.settings.maxWordLength);
    if (!word) return null;

    const editorOffset = line.from + word.from;
    const from = view.domAtPos(editorOffset);
    const to = view.domAtPos(line.from + word.to);
    const range = view.dom.ownerDocument.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    const rect = rectAt(range, x, y);
    return rect ? { owner: view.dom, path, text: word.text, editorOffset, range, rect } : null;
  }
};
