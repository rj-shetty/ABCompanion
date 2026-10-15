// Options page: manage providers, model selection, behavior, and site rules.

import {
  PROVIDER_PRESETS,
  DEFAULT_CONFIG,
  DEFAULT_SETTINGS,
  MSG,
  STORAGE_KEY,
  SESSIONS_INDEX_KEY,
  PROMPT_HISTORY_KEY,
} from "../common/constants.js";
import { presetFor } from "../common/presets.js";
import { isLocalBaseUrl, thinkingVerdict, corsHint } from "../common/model-test-messages.js";
import { loadConfig, saveConfig, loadSessionIndex } from "../background/storage.js";
import { listModels, testModel } from "../background/providers.js";

let config;

const $ = (sel) => document.querySelector(sel);
const presetSelect = $("#preset-select");
const providerList = $("#provider-list");
const noProviders = $("#no-providers");
const permList = $("#perm-list");
const noPerms = $("#no-perms");
const toast = $("#toast");

// One model test per provider card at a time, keyed by the card element so that
// renderProviders() can stop everything it is about to detach. Declared up here
// with the rest of the module state because renderProviders() and
// addProviderFromPreset() both reach for it.
const autoTests = new Map(); // card -> { timer, controller, runId, dots, fingerprint }
const AUTO_TEST_DEBOUNCE_MS = 700;
const DOT_INTERVAL_MS = 350;
const MAX_DOTS = 6;
const PROBE_LABELS = [["text", "Text"], ["tools", "Tools"], ["vision", "Vision"]];
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

init();

async function init() {
  config = await loadConfig();

  for (const p of PROVIDER_PRESETS) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    presetSelect.appendChild(opt);
  }

  $("#add-provider").addEventListener("click", addProviderFromPreset);
  wireSettings();
  wireRail();
  renderAll();

  // This page holds `config` in memory and persist() writes the WHOLE object.
  // Other surfaces also write the config while this page is open — the side
  // panel changes autonomy and the agent grants per-site permissions. Without
  // reloading here, the next persist() would clobber those with a stale snapshot. So on
  // any external write, re-read and re-render.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === "local" && (changes[SESSIONS_INDEX_KEY] || changes[PROMPT_HISTORY_KEY])) renderHistoryCard();
    if (area !== "local" || !changes[STORAGE_KEY]) return;
    if (selfWrites > 0) {
      selfWrites--; // our own persist() — in-memory config is already current
      return;
    }
    config = await loadConfig();
    renderAll();
  });
}

// Keep the rail in sync with the section nearest the reader's current position.
// A position marker works for tall sections and for the final section at the
// bottom of the page, where multiple sections can be visible at once.
function wireRail() {
  const links = [...document.querySelectorAll(".rail a")];
  const sections = links
    .map((link) => document.getElementById(link.getAttribute("href").slice(1)))
    .filter(Boolean);

  function setActive(id) {
    for (const link of links) {
      link.classList.toggle("active", link.getAttribute("href") === "#" + id);
    }
  }

  function updateActive() {
    if (!sections.length) return;
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    const atBottom = maxScroll > 2 && window.scrollY >= maxScroll - 2;
    let active = atBottom ? sections[sections.length - 1] : sections[0];
    if (!atBottom) {
      const marker = Math.max(100, Math.min(window.innerHeight * 0.4, 280));
      for (const section of sections) {
        if (section.getBoundingClientRect().top <= marker) active = section;
        else break;
      }
    }
    setActive(active.id);
  }

  for (const link of links) {
    link.addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = document.getElementById(link.getAttribute("href").slice(1));
      if (!target) return;
      event.preventDefault();
      setActive(target.id);
      if (window.location.hash !== link.getAttribute("href")) {
        window.history.replaceState(null, "", link.getAttribute("href"));
      }
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  window.addEventListener("scroll", updateActive, { passive: true });
  window.addEventListener("resize", updateActive);
  window.addEventListener("hashchange", updateActive);
  updateActive();
}
function renderAll() {
  renderProviders();
  renderSettings();
  renderPermissions();
}

// -------------------------------------------------------------------------
// Providers
// -------------------------------------------------------------------------
function addProviderFromPreset() {
  const presetId = presetSelect.value;
  if (!presetId) return;
  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);
  const provider = {
    id: crypto.randomUUID(),
    presetId: preset.id,
    name: preset.name,
    type: preset.type,
    baseUrl: preset.baseUrl,
    apiKey: "",
    model: preset.defaultModel || "",
    keyUrl: preset.keyUrl || "",
    models: [],
  };
  config.providers.push(provider);
  // Make it active if it's the first one.
  if (!config.activeProviderId) {
    config.activeProviderId = provider.id;
    config.activeModel = provider.model;
  }
  presetSelect.value = "";
  persist();
  renderProviders();
  // A local provider with a pre-filled model can be probed right away; a hosted
  // one has nothing to probe with until its key is pasted.
  const card = providerList.querySelector(`.provider[data-id="${provider.id}"]`);
  if (card && provider.model && (provider.apiKey || isLocalBaseUrl(provider.baseUrl))) {
    scheduleAutoTest(provider, card, { immediate: true, firstRun: true });
  }
}

function renderProviders() {
  // Every card is thrown away here, so stop the pending debounce timers, dot
  // animations and in-flight probes first — an interval left behind would tick
  // against a detached node forever. A run that was still in flight is started
  // again on the rebuilt card below, so an unrelated config update cannot swallow it.
  const wasTesting = [];
  for (const [card, state] of autoTests) {
    if (state.controller) wasTesting.push(card.dataset.id);
    stopTest(card);
  }
  autoTests.clear();
  providerList.innerHTML = "";
  noProviders.hidden = config.providers.length > 0;

  const tpl = $("#provider-template");
  for (const provider of config.providers) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = provider.id;
    const active = config.activeProviderId === provider.id;
    node.classList.toggle("active", active);

    node.querySelector(".pname").textContent = provider.name;
    node.querySelector(".type-badge").textContent = provider.type;
    const radio = node.querySelector('input[name="active-provider"]');
    radio.checked = active;
    radio.addEventListener("change", () => setActive(provider.id));

    const baseUrl = node.querySelector(".base-url");
    baseUrl.value = provider.baseUrl;
    baseUrl.addEventListener("change", () => {
      provider.baseUrl = baseUrl.value.trim();
      persist();
      // A verdict from the old endpoint says nothing about this one, so it is
      // either replaced by a fresh run or cleared.
      scheduleAutoTest(provider, node, { immediate: true });
    });

    const keyInput = node.querySelector(".api-key");
    keyInput.value = provider.apiKey || "";
    keyInput.addEventListener("change", () => {
      provider.apiKey = keyInput.value.trim();
      persist();
      // The key was the only thing the probes were waiting for.
      if (node.querySelector(".model").value.trim()) scheduleAutoTest(provider, node, { immediate: true });
    });
    const keyLink = node.querySelector(".key-link");
    if (provider.keyUrl) {
      keyLink.href = provider.keyUrl;
      keyLink.hidden = false;
    }

    const modelInput = node.querySelector(".model");
    const datalist = node.querySelector("datalist");
    const listId = "models-" + provider.id;
    datalist.id = listId;
    modelInput.setAttribute("list", listId);
    modelInput.value = provider.model || "";
    fillDatalist(datalist, provider.models);
    renderSuggestions(node, provider);
    // Typing is debounced; committing a value (datalist pick, or a blur that
    // changed it) tests at once. Either way one pick is one run: the pending
    // timer is dropped, and a commit that repeats the configuration a run has
    // already started is skipped (see startModelTest).
    modelInput.addEventListener("input", () => scheduleAutoTest(provider, node));
    modelInput.addEventListener("change", () => {
      provider.model = modelInput.value.trim();
      if (config.activeProviderId === provider.id) config.activeModel = provider.model;
      persist();
      scheduleAutoTest(provider, node, { immediate: true });
    });

    const fetchBtn = node.querySelector(".fetch-models");
    const fetchStatus = node.querySelector(".fetch-status");
    // A fresh list changes which suggestions it is known to contain.
    fetchBtn.addEventListener("click", () =>
      fetchModels(provider, fetchBtn, fetchStatus, datalist).then(() => renderSuggestions(node, provider)),
    );

    const testBtn = node.querySelector(".test-model");
    testBtn.addEventListener("click", () => startModelTest(provider, node));

    node.querySelector(".delete-provider").addEventListener("click", () => removeProvider(provider.id));

    providerList.appendChild(node);
  }
  for (const id of wasTesting) {
    const provider = config.providers.find((p) => p.id === id);
    const card = providerList.querySelector(`.provider[data-id="${id}"]`);
    if (provider && card) scheduleAutoTest(provider, card, { immediate: true });
  }
}

function setActive(id) {
  config.activeProviderId = id;
  const provider = config.providers.find((p) => p.id === id);
  if (provider) config.activeModel = provider.model;
  persist();
  renderProviders();
}

function removeProvider(id) {
  config.providers = config.providers.filter((p) => p.id !== id);
  if (config.activeProviderId === id) {
    config.activeProviderId = config.providers[0]?.id || null;
    config.activeModel = config.providers[0]?.model || null;
  }
  persist();
  renderProviders();
}

async function fetchModels(provider, btn, status, datalist) {
  btn.disabled = true;
  status.textContent = "Fetching…";
  status.style.color = "var(--os-muted)";
  try {
    const models = await listModels(provider);
    provider.models = models;
    fillDatalist(datalist, models);
    persist();
    status.textContent = `Found ${models.length} models. Start typing to filter.`;
  } catch (e) {
    const hint = corsHint(provider, e.status);
    status.textContent = hint
      ? `Could not fetch models. ${hint.text} See the README: Using a local model.`
      : "Could not fetch models: " + (e.message || e);
    status.style.color = "var(--os-bad-ink)";
  } finally {
    btn.disabled = false;
  }
}

function testState(card) {
  let state = autoTests.get(card);
  if (!state) {
    state = { timer: null, controller: null, runId: 0, dots: null, fingerprint: "" };
    autoTests.set(card, state);
  }
  return state;
}

function stopTest(card) {
  const state = autoTests.get(card);
  if (!state) return;
  clearTimeout(state.timer);
  clearInterval(state.dots);
  state.timer = null;
  state.dots = null;
  if (state.controller) state.controller.abort();
  state.controller = null;
  // An aborted run can still have a probe resolving in the same tick, and it
  // must not repaint over the status this just cleared — so its run id is
  // retired here, not only when a replacement run claims the next one.
  state.runId++;
  state.fingerprint = "";
}

// What an automatic run is "for": the same three inputs twice over is the same
// answer twice over, so the second run is dropped. Held in memory only — it
// carries the key and is never rendered or logged.
const testFingerprint = (provider, model) => JSON.stringify([model, provider.baseUrl || "", provider.apiKey || ""]);

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

// A status line is only ever shown with something in it.
function setStatus(statusEl, html) {
  statusEl.innerHTML = html;
  statusEl.hidden = false;
}

function clearStatus(statusEl) {
  statusEl.innerHTML = "";
  statusEl.hidden = true;
}

// Provider error bodies sometimes echo the key back (401s like to), and these
// lines now appear without anyone pressing a button — so nothing key-shaped
// reaches the screen.
function redactKeys(detail, apiKey) {
  let s = String(detail ?? "");
  if (apiKey && apiKey.length >= 8) s = s.split(apiKey).join("[key]");
  return s.replace(/\b(?:sk|or|pk|gsk)-[A-Za-z0-9_-]{8,}/g, "[key]");
}

const isNetworkFail = (detail) => /failed to fetch|load failed|network ?error|connection refused|econnrefused/i.test(String(detail || ""));

// Picking a model is the moment the user wants to know whether it works, so the
// probes run then and there instead of waiting for a button. Base URL and key
// are read from the provider (both commit on blur, before the model is touched);
// the model comes from the input, which is still mid-edit.
function scheduleAutoTest(provider, card, { immediate = false, firstRun = false } = {}) {
  const statusEl = card.querySelector(".test-status");
  const model = card.querySelector(".model").value.trim();
  const state = testState(card);
  clearTimeout(state.timer);
  state.timer = null;

  if (!model) {
    stopTest(card);
    clearStatus(statusEl);
    return;
  }
  if (!provider.baseUrl) return; // the Test button is where that gets explained
  if (!provider.apiKey && !isLocalBaseUrl(provider.baseUrl)) {
    stopTest(card);
    setStatus(statusEl, `<span class="test-line muted">Add your API key and the test will run automatically.</span>`);
    return;
  }
  if (immediate) {
    startModelTest(provider, card, { auto: true, firstRun });
    return;
  }
  // Mid-typing, only a model id the provider actually lists is worth three live
  // requests: a pause longer than the debounce after "gpt-" would otherwise
  // probe a model that doesn't exist. Anything else waits for the commit.
  if (!(provider.models || []).includes(model)) {
    // Whatever verdict is on screen was for a different model id, and the field
    // no longer says that — drop it rather than let it describe the new one.
    if (!state.controller && state.fingerprint && state.fingerprint !== testFingerprint(provider, model)) {
      state.fingerprint = "";
      clearStatus(statusEl);
    }
    return;
  }
  state.timer = setTimeout(() => startModelTest(provider, card, { auto: true }), AUTO_TEST_DEBOUNCE_MS);
}

// The one entry point for both the Test button and the automatic runs: cancels
// whatever that card was doing and claims the card's next run id.
function startModelTest(provider, card, { auto = false, firstRun = false } = {}) {
  const state = testState(card);
  const model = card.querySelector(".model").value.trim();
  const fingerprint = testFingerprint(provider, model);
  // Typing a model id and then blurring the field fires both the debounced
  // "input" run and the commit "change" run for one and the same model — the
  // second is the same three requests for the same answer, so it is dropped.
  // The Test button is the deliberate re-run and always goes through.
  if (auto && fingerprint === state.fingerprint) return;
  clearTimeout(state.timer);
  state.timer = null;
  if (state.controller) state.controller.abort();
  state.controller = new AbortController();
  state.fingerprint = fingerprint;
  return runModelTest(provider, card.querySelector(".model"), card.querySelector(".test-model"), card.querySelector(".test-status"), {
    auto,
    firstRun,
    signal: state.controller.signal,
    runId: ++state.runId,
  });
}

async function runModelTest(provider, modelInput, btn, statusEl, opts = {}) {
  const { auto = false, firstRun = false, signal, runId } = opts;
  const state = testState(statusEl.closest(".provider"));
  // A cancelled run can still have a probe in flight; everything it would
  // render or re-enable is dropped once the card has moved on.
  const current = () => runId === undefined || state.runId === runId;
  const model = (modelInput.value || provider.model || "").trim();
  if (!model) {
    if (!auto) setStatus(statusEl, `<span class="test-line fail">Enter a model id first.</span>`);
    return;
  }
  if (!provider.baseUrl) {
    if (!auto) setStatus(statusEl, `<span class="test-line fail">Set the provider's Base URL first.</span>`);
    return;
  }
  btn.disabled = true;

  const icon = { ok: "✓", warn: "⚠", fail: "✗" };
  const line = (label, res) =>
    `<span class="test-line ${res.status}">${icon[res.status]} <strong>${label}</strong> — ${escapeHtml(redactKeys(res.detail, provider.apiKey))}</span>`;
  // The model id stays on screen: an automatic run nobody asked for has to say
  // which model the ticks belong to — and, while it is running, where the key
  // is going, since no button was pressed to authorise that.
  const host = hostOf(provider.baseUrl);
  const nameLine = (verb, withHost) =>
    `<span class="test-line muted">${verb} <code>${escapeHtml(model)}</code>${withHost && host ? ` at ${escapeHtml(host)}` : ""}</span>`;
  let stage = "text";
  let dots = 1;
  let doneLines = [];
  let dotsEl = null;
  const dotText = () => (reducedMotion.matches ? "…" : ".".repeat(dots));
  // The block is rewritten only when a probe finishes; in between, the ticker
  // writes into the dot span alone, so the role="status" region isn't re-read
  // to a screen reader three times a second.
  const paint = () => {
    if (!current()) return;
    setStatus(
      statusEl,
      [
        nameLine("Testing", true),
        ...doneLines,
        `<span class="test-line muted test-progress">… testing ${stage} <span class="dots" aria-hidden="true">${dotText()}</span></span>`,
      ].join(""),
    );
    dotsEl = statusEl.querySelector(".test-progress .dots");
  };
  paint();
  clearInterval(state.dots);
  const ticker = setInterval(() => {
    if (!current()) return;
    dots = dots >= MAX_DOTS ? 1 : dots + 1;
    if (dotsEl) dotsEl.textContent = dotText(); // frozen at "…" under reduced motion
  }, DOT_INTERVAL_MS);
  state.dots = ticker;

  try {
    const r = await testModel({ ...provider, model }, model, {
      signal,
      onProgress: (s, results) => {
        if (s === "done" || !current()) return;
        stage = s;
        dots = 1;
        doneLines = PROBE_LABELS.filter(([key]) => results[key]).map(([key, label]) => line(label, results[key]));
        paint();
      },
    });
    if (!current() || r.aborted) return; // the next run has already taken over
    // A local server that isn't up yet is the overwhelmingly likely reason a
    // just-added preset can't be reached — say so instead of reporting the
    // model as incapable of calling tools.
    if (firstRun && r.text.status === "fail" && isNetworkFail(r.text.detail)) {
      setStatus(statusEl, `<span class="test-line warn">Couldn't reach ${escapeHtml(host)} — start your local server and press Test.</span>`);
      return;
    }
    // A local server that refuses the extension's origin fails every probe the
    // same way; the fix is a server setting, not a different model.
    const hint = r.text.status === "fail" ? corsHint(provider, r.text.httpStatus) : null;
    if (hint) {
      setStatus(
        statusEl,
        [
          nameLine("Tested", false),
          line("Text", r.text),
          `<span class="test-line fail">${escapeHtml(hint.text)}</span>`,
        ].join(""),
      );
      return;
    }
    let verdict = "";
    if (r.tools.status === "ok" && (r.vision.status === "ok" || r.vision.status === "warn")) {
      verdict = `<span class="test-line ok">This model can drive ABCompanion.${r.vision.status === "ok" ? " Vision works too." : ""}</span>`;
    } else if (r.tools.thinking) {
      verdict = `<span class="test-line fail">${escapeHtml(thinkingVerdict(provider, model))}</span>`;
    } else if (r.tools.status !== "ok") {
      verdict = `<span class="test-line fail">Tools didn't work — the agent can't act with this model. Pick a tool-capable one.</span>`;
    } else if (r.vision.status === "fail") {
      verdict = `<span class="test-line warn">Tools work, but this model can't see images. Fine for text tasks; turn off Vision or pick a multimodal model for image work.</span>`;
    }
    setStatus(statusEl, [nameLine("Tested", false), line("Text", r.text), line("Tools", r.tools), line("Vision", r.vision), verdict].join(""));
  } catch (e) {
    if (current()) setStatus(statusEl, `<span class="test-line fail">Test failed: ${escapeHtml(redactKeys(e.message || e, provider.apiKey))}</span>`);
  } finally {
    clearInterval(ticker);
    if (state.dots === ticker) state.dots = null;
    if (current()) {
      btn.disabled = false;
      if (state.controller && state.controller.signal === signal) state.controller = null;
    }
  }
}

// The preset's suggested models as one-click chips under the Model field. A
// chip is a datalist pick by other means: it fires the same input + change pair
// on the model field, so it persists and auto-tests through the same handlers
// (and the same one-run dedupe) as picking from the list.
function renderSuggestions(card, provider) {
  const row = card.querySelector(".suggest-row");
  const chips = row.querySelector(".suggest-chips");
  const suggestions = presetFor(provider)?.suggestions || [];
  chips.innerHTML = "";
  row.hidden = suggestions.length === 0;
  if (!suggestions.length) return;
  // Only a list the provider actually returned can say a model is missing.
  const listed = provider.models || [];
  for (const s of suggestions) {
    const offList = listed.length > 0 && !listed.includes(s.model);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip suggest-chip" + (offList ? " off-list" : "");
    chip.dataset.model = s.model;
    chip.title = `${s.model} · ${s.note}${offList ? " — not in the models this provider returned" : ""}`;
    chip.innerHTML = `<span>${escapeHtml(s.label)}</span><span class="kind-tag">${escapeHtml(s.kind)}</span>`;
    chip.addEventListener("click", () => {
      const input = card.querySelector(".model");
      input.value = s.model;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    chips.appendChild(chip);
  }
}

function fillDatalist(datalist, models) {
  datalist.innerHTML = "";
  for (const m of models || []) {
    const opt = document.createElement("option");
    opt.value = m;
    datalist.appendChild(opt);
  }
}

// -------------------------------------------------------------------------
// Settings
// -------------------------------------------------------------------------
function wireSettings() {
  document.querySelectorAll('input[name="autonomy"]').forEach((r) =>
    r.addEventListener("change", () => {
      config.settings.autonomy = r.value;
      persist();
    }),
  );
  document.querySelectorAll('input[name="siteAccess"]').forEach((r) =>
    r.addEventListener("change", () => {
      config.settings.siteAccess = r.value;
      persist();
    }),
  );
  $("#max-steps").addEventListener("change", (e) => {
    config.settings.maxSteps = clampInt(e.target.value, 1, 100, DEFAULT_SETTINGS.maxSteps);
    persist();
  });
  $("#max-tokens").addEventListener("change", (e) => {
    config.settings.maxTokens = clampInt(e.target.value, 256, 128000, DEFAULT_SETTINGS.maxTokens);
    persist();
  });
  const temp = $("#temperature");
  temp.addEventListener("input", () => {
    $("#temp-value").textContent = Number(temp.value).toFixed(2);
  });
  temp.addEventListener("change", () => {
    config.settings.temperature = Number(temp.value);
    persist();
  });
  $("#enable-vision").addEventListener("change", (e) => {
    config.settings.enableVision = e.target.checked;
    persist();
  });
  $("#keep-history").addEventListener("change", onKeepHistory);
  $("#clear-history").addEventListener("click", clearHistory);
}

function renderSettings() {
  const s = config.settings;
  const radio = document.querySelector(`input[name="autonomy"][value="${s.autonomy}"]`);
  if (radio) radio.checked = true;
  const saRadio = document.querySelector(`input[name="siteAccess"][value="${s.siteAccess || "all"}"]`);
  if (saRadio) saRadio.checked = true;
  $("#max-steps").value = s.maxSteps;
  $("#max-tokens").value = s.maxTokens;
  $("#temperature").value = s.temperature;
  $("#temp-value").textContent = Number(s.temperature).toFixed(2);
  $("#enable-vision").checked = !!s.enableVision;
  $("#keep-history").checked = s.keepHistory !== false;
  renderHistoryCard();
}

// -------------------------------------------------------------------------
// Chat history. The worker owns every write: turning the switch off is just a
// config write (the worker deletes the data when it sees the flip), and Clear
// history is a message. This page only reads the counts.
// -------------------------------------------------------------------------
let historyRender = 0; // bumped per render so a slow read can't show stale counts

async function historyCounts() {
  let chats = 0;
  let prompts = 0;
  try {
    chats = (await loadSessionIndex()).items.length;
    const raw = await chrome.storage.local.get(PROMPT_HISTORY_KEY);
    if (Array.isArray(raw[PROMPT_HISTORY_KEY])) prompts = raw[PROMPT_HISTORY_KEY].length;
  } catch {
    /* storage unavailable — show nothing saved */
  }
  return { chats, prompts };
}

async function renderHistoryCard() {
  const run = ++historyRender;
  const { chats, prompts } = await historyCounts();
  if (run !== historyRender) return;
  const count = $("#history-count");
  const btn = $("#clear-history");
  if (config.settings.keepHistory === false) {
    count.textContent = "History is off. Nothing is saved.";
    btn.disabled = true;
  } else if (chats > 0) {
    count.textContent = `${chats} saved chat${chats === 1 ? "" : "s"} on this device.`;
    btn.disabled = false;
  } else {
    count.textContent = "No saved chats yet.";
    btn.disabled = !prompts;
  }
}

const plural = (n) => (n === 1 ? "" : "s");
const turnOffCopy = (n) =>
  `Turn off chat history?\n\nThis deletes ${n ? `the ${n} chat${plural(n)} saved on this device and ` : ""}your prompt history. It can't be undone. The chat that's open now stays until Chrome closes.`;
const clearCopy = (n) =>
  `Delete all chat history?\n\nThis deletes ${n ? `the ${n} chat${plural(n)} saved on this device, ` : ""}your prompt history and the open chat. It can't be undone.`;

async function onKeepHistory(e) {
  if (e.target.checked) {
    config.settings.keepHistory = true;
    persist();
    renderHistoryCard();
    return;
  }
  const { chats, prompts } = await historyCounts();
  if (chats + prompts > 0 && !confirm(turnOffCopy(chats))) {
    e.target.checked = true;
    return;
  }
  config.settings.keepHistory = false;
  persist();
  renderHistoryCard();
}

async function clearHistory() {
  const status = $("#clear-history-status");
  status.textContent = "";
  const { chats } = await historyCounts();
  if (!confirm(clearCopy(chats))) return;
  const res = await chrome.runtime.sendMessage({ type: MSG.CLEAR_SESSIONS }).catch(() => null);
  status.textContent = res && res.ok
    ? "History cleared."
    : res && res.error === "busy"
      ? "A task is running. Try again when it finishes."
      : "Couldn't clear history. Try again.";
}

// Site permissions
// -------------------------------------------------------------------------
function renderPermissions() {
  const entries = Object.entries(config.sitePermissions || {});
  permList.innerHTML = "";
  noPerms.hidden = entries.length > 0;
  for (const [origin, state] of entries) {
    const row = document.createElement("div");
    row.className = "perm-item";
    row.innerHTML = `
      <span class="origin">${escapeHtml(origin)}</span>
      <span class="perm-state ${state}">${state === "allow" ? "allowed" : "blocked"}</span>
      <button class="link-btn">Remove</button>`;
    row.querySelector("button").addEventListener("click", () => {
      delete config.sitePermissions[origin];
      persist();
      renderPermissions();
    });
    permList.appendChild(row);
  }
}

// Helpers
// -------------------------------------------------------------------------
let toastTimer = null;
let selfWrites = 0; // storage.onChanged events caused by our own persist()
async function persist() {
  selfWrites++;
  try {
    await saveConfig(config);
  } catch (e) {
    selfWrites--; // the write never happened, so no onChanged will fire for it
    throw e;
  }
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 1600);
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
