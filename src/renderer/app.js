// src/renderer/app.js
// Project Picker + Workspace I/O + Drag-and-Drop Reorder + Delete + Menu integration + Autosave
/* eslint-disable @typescript-eslint/no-var-requires */

(() => {
  "use strict";

/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');

// DEV: verification marker — helps confirm which app.js the renderer actually loaded.
// This prints a distinct tag to the console and into the debug logger (if wired).
try {
  const scriptEl = (typeof document !== 'undefined') ? document.querySelector('script[src$="src/renderer/app.js"]') : null;
  const scriptSrc = scriptEl ? scriptEl.src : (typeof document !== 'undefined' && document.currentScript ? document.currentScript.src : null);
  console.log('[dev-mark] app.js loaded; scriptSrc=', scriptSrc || window.location.href);
  try { dbg && dbg(`[dev-mark] app.js loaded from ${scriptSrc || window.location.href}`); } catch (e) { /* best-effort */ }

  // Also try a local disk check to show whether the workspace copy exists where we expect it.
  try {
    const diskPath = path.join(process.cwd(), 'src', 'renderer', 'app.js');
    const exists = fs.existsSync(diskPath);
    try { dbg && dbg(`[dev-mark] diskExists=${exists} path=${diskPath}`); } catch (e) {}
    if (exists) {
      try {
        const snippet = fs.readFileSync(diskPath, 'utf8').slice(0, 256).replace(/\n/g, ' ');
        const hasLore = snippet.indexOf('Lore Editor') !== -1 || snippet.indexOf('lore-editor') !== -1;
        try { dbg && dbg(`[dev-mark] diskSnippetHasLore=${hasLore}`); } catch (e) {}
      } catch (e) { try { dbg && dbg('[dev-mark] read disk snippet failed: ' + (e && e.message)); } catch (__) {} }
    }
  } catch (e) { try { dbg && dbg('[dev-mark] disk probe failed: ' + (e && e.message)); } catch (__) {} }
} catch (e) { try { console.log('[dev-mark] setup failed', e && e.message); } catch (__) {} }

// ───────────────── Debug helpers ─────────────────
let LOG_FILE = null;
const _dbgBuf = [];                // buffer while we don't know workspace
function _dbgAppendToFile(line) {
  try {
    if (!fs || !path || !LOG_FILE) {
      _dbgBuf.push(line);
      // Always try to resolve log path immediately for any message
      _wireDebugLogPathEarly().catch(() => {});
      return;
    }
    fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch (_) { /* ignore */ }
}
function dbg(msg) {
  const stamp = new Date().toISOString();
  const line  = `[${stamp}] ${String(msg)}`;
  console.log("[debug]", msg);
  _dbgAppendToFile(line);
  // Also forward every renderer debug line to the main process so it appears in the global log
  try { if (ipcRenderer && ipcRenderer.invoke) ipcRenderer.invoke('debug:append', { line }).catch(() => {}); } catch (_) { /* best-effort */ }
  const b = document.getElementById("debug-banner");
  if (b) b.textContent = `[debug] ${msg}`;
}

// NEW: resolve debug log target ASAP using main's active workspace
async function _wireDebugLogPathEarly() {
  if (!ipcRenderer || !path) return;
  try {
    // First try to get active workspace path
    const r = await ipcRenderer.invoke("project:activePath");
    if (r?.ok && r.activePath) {
      LOG_FILE = path.join(r.activePath, "debug.log");
    } else {
      // Fallback: Try to get global app log path from main
      const globalLog = await ipcRenderer.invoke("debug:getGlobalLogPath");
      if (globalLog?.ok && globalLog.path) {
        LOG_FILE = globalLog.path;
      } else {
        // Final fallback: Use app's root folder
        const appRoot = await ipcRenderer.invoke("app:getPath", { name: "userData" });
        if (appRoot?.ok) {
          LOG_FILE = path.join(appRoot.path, "debug.log");
        }
      }
    }

    if (LOG_FILE) {
      // Ensure log directory exists
      try {
        const logDir = path.dirname(LOG_FILE);
        if (!fs.existsSync(logDir)) {
          fs.mkdirSync(logDir, { recursive: true });
        }
      } catch (e) {
        console.warn("Failed to create log directory:", e);
      }

      // Flush any buffered lines
      for (const ln of _dbgBuf.splice(0, _dbgBuf.length)) {
        try { fs.appendFileSync(LOG_FILE, ln + "\n", "utf8"); } catch {}
      }
      dbg(`debug log wired → ${LOG_FILE}`);
    }
  } catch (e) {
    console.warn("Failed to wire debug log:", e);
  }
}

(function banner() {
  const b = document.createElement("div");
    b.id = "debug-banner";
    b.style.cssText =
      "position:fixed;right:8px;bottom:8px;z-index:99999;background:#111827;color:#e5e7eb;padding:8px 10px;border-radius:8px;font:12px/1.2 -apple-system,Segoe UI,Roboto,Inter,sans-serif;opacity:.9;max-width:520px;box-shadow:0 6px 20px rgba(0,0,0,.25)";
    b.textContent = "[debug] boot…";
    document.addEventListener("DOMContentLoaded", () => document.body.appendChild(b));
  })();

  // Verify Node/Electron requirements are loaded
  if (!fs || !path || !ipcRenderer) {
    dbg("Node/Electron requirements missing. Check nodeIntegration/contextIsolation.");
    console.error("Missing required modules");
  } else {
    dbg("require(fs,path,ipcRenderer) OK");
  }

  // Listen for background fullLoad completion from main and refresh project list
  try {
    if (ipcRenderer && ipcRenderer.on) {
      ipcRenderer.on('auth:fullLoadDone', (_evt, payload) => {
        try {
          dbg('auth:fullLoadDone received — refreshing project list');
          // refreshProjectList is declared later; call it (function declarations are hoisted)
          try { refreshProjectList(); } catch (e) { dbg(`refreshProjectList failed: ${e?.message || e}`); }
        } catch (e) { /* best-effort */ }
      });
    }
  } catch (e) { /* best-effort */ }

  // ───────────────── Global/State ─────────────────
  const state = {
    projectName: "Untitled Project",
    activeTab: "chapters", // "chapters" | "notes" | "references"
    entries: [],           // { id, type, title, ... }
    selectedId: null,
  // counters: chapters, notes, references, and unified lore entries
  counters: { chapter: 1, note: 1, reference: 1, lore: 1 },

    // Logged-in creator info ─────────────
    authUser: null,  // { id, code, email, name } or null

    // Project system
    workspacePath: null,       // <userData>/workspace
    currentProjectDir: null,   // Documents/InkDoodleProjects/<ProjectName>

    // Autosave
    dirty: false,
    lastSavedAt: 0,

    // Drag and drop
    drag: {
      draggingId: null,
      overId: null,
      overPosition: null, // "before" | "after"
    },

    // UI preferences (theme/background)
    uiPrefs: {
      mode: "theme",       // "theme" | "background"
      theme: "slate",      // "slate" | "light" | "dark" | "forest" | "rose"
      bg: "aurora",        // "none" | "aurora" | "space" | "sunset" | "ocean"
      bgOpacity: 0.2,      // 0..0.6
      bgBlur: 2,           // px (0..8)
      editorDim: false,    // dim editor panel for readability
    },
  // Lore UI (unified lore type — no subtabs)
  };

  // Will be set after we know workspacePath:
  let SAVE_FILE = null; // <workspace>/data/project.json

  // ───────────── Finder Modal ─────────────
  let finderEl = null;
  let finderInput = null;
  let finderList = null;
  let finderAllScope = true; // search across all types by default

  function ensureFinder() {
    if (finderEl) return finderEl;
    finderEl = document.createElement("div");
    finderEl.id = "finder";
    finderEl.innerHTML = `
      <div class="card" role="dialog" aria-modal="true" aria-label="Find">
        <div class="row">
          <input id="finder-input" type="text" placeholder="Find by title or tag… (Esc to close)" />
          <div class="scopes">
            <label class="scope"><input type="checkbox" id="finder-scope-all" checked /> All</label>
            <label class="scope"><input type="checkbox" id="finder-scope-ch" /> Chapters</label>
            <label class="scope"><input type="checkbox" id="finder-scope-no" /> Notes</label>
            <label class="scope"><input type="checkbox" id="finder-scope-re" /> References</label>
          </div>
          <button id="finder-close" class="btn">Close</button>
        </div>
        <div id="finder-list" class="list" role="listbox" aria-label="Results"></div>
      </div>
    `;
    document.body.appendChild(finderEl);

    finderInput = finderEl.querySelector("#finder-input");
    finderList  = finderEl.querySelector("#finder-list");

    const scopeAll = finderEl.querySelector("#finder-scope-all");
    const scopeCh  = finderEl.querySelector("#finder-scope-ch");
    const scopeNo  = finderEl.querySelector("#finder-scope-no");
    const scopeRe  = finderEl.querySelector("#finder-scope-re");

    function readScopes() {
      if (scopeAll.checked) return { all: true, types: ["chapter","note","reference"] };
      const types = [];
      if (scopeCh.checked) types.push("chapter");
      if (scopeNo.checked) types.push("note");
      if (scopeRe.checked) types.push("reference");
      return { all: false, types: types.length ? types : ["chapter","note","reference"] };
    }

    function selectEntryFromFinder(entry) {
      const tab = typeTabMap[entry.type];
      if (tab && tab !== state.activeTab) switchTab(tab);
      selectEntry(entry.id);
      hideFinder();
    }

    function renderResults(query) {
      const q = (query || "").trim().toLowerCase();
      const { types } = readScopes();
      const pool = state.entries.filter(e => types.includes(e.type));

      let results = pool;
      if (q) {
        results = pool.filter(e => {
          const titleHit = (e.title || "").toLowerCase().includes(q);
          const tagHit = (e.tags || []).some(t => (t || "").toLowerCase().includes(q));
          return titleHit || tagHit;
        });
      }
      results = results
        .sort((a,b) => (b.updated_at || "").localeCompare(a.updated_at || ""))
        .slice(0, 100);

      finderList.innerHTML = "";
      if (!results.length) {
        finderList.innerHTML = `<div class="item"><div class="left"><span class="meta">No results</span></div></div>`;
        return;
      }

      for (const e of results) {
        const row = document.createElement("div");
        row.className = "item";
        row.innerHTML = `
          <div class="left">
            <span class="badge">${e.type}</span>
            <span class="title">${e.title || "(Untitled)"}</span>
          </div>
          <div class="meta">${timeAgo(e.updated_at)}${(e.tags && e.tags.length) ? " • " + e.tags.join(", ") : ""}</div>
        `;
        row.addEventListener("click", () => selectEntryFromFinder(e));
        finderList.appendChild(row);
      }
    }

    finderInput.addEventListener("input", () => renderResults(finderInput.value));
    finderEl.querySelector("#finder-close").addEventListener("click", hideFinder);
    [ "#finder-scope-all", "#finder-scope-ch", "#finder-scope-no", "#finder-scope-re" ]
      .forEach(sel => finderEl.querySelector(sel).addEventListener("change", () => {
        if (sel === "#finder-scope-all") {
          const checked = finderEl.querySelector(sel).checked;
          finderEl.querySelector("#finder-scope-ch").checked = !checked;
          finderEl.querySelector("#finder-scope-no").checked = !checked;
          finderEl.querySelector("#finder-scope-re").checked = !checked;
        } else {
          finderEl.querySelector("#finder-scope-all").checked = false;
        }
        renderResults(finderInput.value);
      }));

    finderInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        const first = finderList.querySelector(".item");
        if (first) first.click();
      } else if (ev.key === "Escape") {
        hideFinder();
      }
    });

    return finderEl;
  }

  function showFinder(prefill = "") {
    ensureFinder();
    finderEl.style.display = "flex";
    finderInput.value = prefill || "";
    finderInput.focus();
    finderInput.setSelectionRange(0, finderInput.value.length);

    // if no query, show recents
    finderList.innerHTML = "";
    if (!finderInput.value.trim()) {
      const recent = state.entries
        .slice()
        .sort((a,b) => (b.updated_at || "").localeCompare(a.updated_at || ""))
        .slice(0, 50);
      for (const e of recent) {
        const row = document.createElement("div");
        row.className = "item";
        row.innerHTML = `
          <div class="left">
            <span class="badge">${e.type}</span>
            <span class="title">${e.title || "(Untitled)"}</span>
          </div>
          <div class="meta">${timeAgo(e.updated_at)}${(e.tags && e.tags.length) ? " • " + e.tags.join(", ") : ""}</div>
        `;
        row.addEventListener("click", () => {
          const tab = typeTabMap[e.type];
          if (tab && tab !== state.activeTab) switchTab(tab);
          selectEntry(e.id);
          hideFinder();
        });
        finderList.appendChild(row);
      }
    } else {
      finderInput.dispatchEvent(new Event("input"));
    }
  }

  function hideFinder() {
    if (!finderEl) return;
    finderEl.style.display = "none";
  }

  // ───────────────── Login Modal (email-only MVP) ─────────────────
  let loginModal = null;

  // Debug helper for login flow
  function loginDbg(msg) {
    try {
      dbg(`[login] ${msg}`);
    } catch (e) {
      console.log("[login-debug]", msg);
    }
  }

  function ensureLoginModal() {
    if (loginModal) return loginModal;

    // First remove any existing login modal
    const existingModal = document.getElementById("login-modal-dynamic");
    if (existingModal) existingModal.remove();

    loginModal = document.createElement("div");
    loginModal.id = "login-modal-dynamic";
    loginModal.innerHTML = `
      <div class="login-card" tabindex="-1">
        <h2>Sign in to Ink Doodle</h2>
        <p class="sub">Enter your email to load your projects from the cloud.</p>
        <div class="input-wrap" tabindex="-1">
          <input id="login-email-dynamic" 
                 type="email" 
                 placeholder="you@example.com" 
                 spellcheck="false" 
                 autocomplete="email" 
                 autocapitalize="off"
                 enterkeyhint="go"
                 tabindex="1" />
        </div>
        <button id="login-btn-dynamic" class="btn primary" tabindex="2">Sign In</button>
      </div>`;
    document.body.appendChild(loginModal);

    const style = document.createElement("style");
    style.textContent = `
      #login-modal-dynamic { 
        position: fixed; inset: 0; 
        background: rgba(17,24,39,.85);
        display: flex; 
        align-items: center; 
        justify-content: center; 
        z-index: 2147483647;
        -webkit-app-region: no-drag;
      }
      #login-modal-dynamic .login-card { 
        position: relative;
        background: #fff; 
        padding: 24px 28px; 
        border-radius: 12px;
        width: min(340px,90vw); 
        text-align: center; 
        font-family: Inter,system-ui,sans-serif;
        box-shadow: 0 20px 60px rgba(0,0,0,.35);
        -webkit-app-region: no-drag;
      }
      #login-modal-dynamic h2 { 
        margin: 0 0 4px; 
        font-size: 20px; 
        font-weight: 700; 
      }
      #login-modal-dynamic .sub { 
        font-size: 13px; 
        color: #6b7280; 
        margin-bottom: 12px; 
      }
      #login-modal-dynamic .input-wrap {
        margin: 16px 0;
      }
      #login-email-dynamic { 
        width: 100%; 
        padding: 10px; 
        font-size: 14px; 
        border: 1px solid #d1d5db;
        border-radius: 8px; 
        margin-bottom: 10px;
        background: #fff;
        position: relative;
        z-index: 2147483647;
        -webkit-app-region: no-drag;
        -webkit-user-select: text;
        user-select: text;
      }
      #login-btn-dynamic { 
        padding: 8px 12px; 
        border: none; 
        border-radius: 8px;
        background: #2563eb; 
        color: #fff; 
        cursor: pointer; 
        font-weight: 600;
        width: 100%;
      }
      #login-btn-dynamic:hover { 
        background: #1d4ed8; 
      }`;
    document.head.appendChild(style);

      const emailInput = loginModal.querySelector("#login-email-dynamic");
      const loginButton = loginModal.querySelector("#login-btn-dynamic");
      
      dbg("login-modal: elements initialized");

      // Helper to validate email format
      const isValidEmail = (email) => {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      };

      // Handle Enter key in email input 
      emailInput.addEventListener("keydown", async (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          loginButton.click();
        } else if (e.key === "Escape") {
          e.preventDefault();
          hideLoginModal();
        }
      });

      loginButton.addEventListener("click", async () => {
        const email = emailInput.value.trim();
        if (!email || !email.includes('@')) {
          alert("Please enter a valid email address.");
          emailInput.focus();
          return;
        }

        // Disable input and button while logging in
        emailInput.disabled = true;
        loginButton.disabled = true;
        loginButton.textContent = "Signing in...";

        dbg(`login: attempting for ${email}`);
        try {
          const res = await ipcRenderer.invoke("auth:login", { email });
          if (!res?.ok) {
            // Re-enable on error
            emailInput.disabled = false;
            loginButton.disabled = false;
            loginButton.textContent = "Sign In";
            return alert(res?.error || "Login failed.");
          }

          state.authUser = res.user;
          dbg(`login -> ${res.user.email}`);

          // Hide login modal and show project picker
          hideLoginModal();
          hideProjectPicker(); // Hide any existing picker first

          // Reset state for next time
          emailInput.disabled = false;
          emailInput.value = "";
          loginButton.disabled = false;
          loginButton.textContent = "Sign In";

          // Immediately show picker after a successful login
          dbg("login: showing project picker now");
          ensureProjectPicker();
          showProjectPicker();
        } catch (e) {
          // Re-enable on error
          emailInput.disabled = false;
          loginButton.disabled = false;
          loginButton.textContent = "Sign In";
          alert(`Login error:\n${e?.message || e}`);
        }
      });

      return loginModal;
  }

  function showLoginModal() {
    loginDbg("Showing login modal");
    ensureLoginModal();
    
    // Ensure modal exists and is properly configured before showing
    if (!loginModal) {
      loginDbg("ERROR: Modal creation failed");
      return;
    }
    
    // Reset state and clear any existing input values
    const emailInput = loginModal.querySelector("#login-email-dynamic");
    const loginButton = loginModal.querySelector("#login-btn-dynamic");
    
    if (!emailInput || !loginButton) {
      loginDbg("ERROR: Required modal elements not found");
      return;
    }

    // Reset input state
    emailInput.value = "";
    emailInput.disabled = false;
    loginButton.disabled = false;
    loginButton.textContent = "Sign In";
    
    // Show the modal
    loginModal.style.display = "flex";
    
    // Ensure modal is actually visible
    if (loginModal.style.display !== "flex") {
      loginDbg("ERROR: Failed to show modal");
      return;
    }

    // Focus email input after a short delay to ensure modal is ready
    setTimeout(() => {
      try {
        emailInput.focus();
      } catch (e) {
        loginDbg("Warning: Could not focus email input");
      }
    }, 100);
    
    loginDbg("Login modal shown successfully");
  }

  function hideLoginModal() {
    if (!loginModal) {
      loginDbg("No modal to hide");
      return;
    }

    loginDbg("Hiding login modal");
    
    // Reset state when hiding
    const emailInput = loginModal.querySelector("#login-email-dynamic");
    const loginButton = loginModal.querySelector("#login-btn-dynamic");
    
    if (emailInput && loginButton) {
      emailInput.value = "";
      emailInput.disabled = false;
      loginButton.disabled = false;
      loginButton.textContent = "Sign In";
    }

    loginModal.style.display = "none";
    loginDbg("Login modal hidden and state reset");
  }

  // Autosave tunables
  const AUTOSAVE_IDLE_MS = 1500;      // wait after edits
  const AUTOSAVE_FAILSAFE_MS = 20000; // if still dirty after this, force save
  let autosaveDebounce = null;
  let failsafeTimer = null;

  // ───────────────── DOM ─────────────────
  const $  = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const el = {
    projectName: $("#project-name"),
    entryList: $("#entry-list"),
    empty: $("#empty-state"),
  // Only the main writing tabs (chapters/notes/references). Lore subtabs are wired separately.
  tabs: document.querySelectorAll('.tabs-writing .tab'),
    newBtn: $("#new-btn"),
    quickCreate: $$("#empty-state [data-new]"),
    // Editor fields
    titleInput: $("#title-input"),
    status: $("#status"),
    tags: $("#tags"),
    synopsis: $("#synopsis"),
    body: $("#body"),
    wordTarget: $("#word-target"),
    // Notes-only
    noteCategory: $("#note-category"),
    notePin: $("#note-pin"),
    // References-only
    referenceType: $("#reference-type"),
    sourceLink: $("#source-link"),
    // Labels/wrappers
    statusWrapper: $("#status-wrapper"),
    tagsWrapper: $("#tags-wrapper"),
    noteCategoryWrapper: $("#note-category-wrapper"),
    notePinWrapper: $("#note-pin-wrapper"),
    referenceTypeWrapper: $("#reference-type-wrapper"),
    sourceLinkLabel: $("#source-link-label"),
    synopsisLabel: $("#synopsis-label"),
    bodyLabel: $("#body-label"),
    wordTargetWrapper: $("#word-target-wrapper"),
    // Status/footer
    wordCount: $("#word-count"),
    saveState: $("#save-state"),
    lastSaved: $("#last-saved"),
    saveBtn: $("#save-btn"),
    deleteBtn: $("#editor-delete-btn"),

    // Word goal (bottom bar)
    goalWrap: $("#goal-wrap"),
    wordGoal: $("#word-goal"),
    goalProgress: $("#goal-progress"),
    goalFill: $("#goal-fill"),
    goalPct: $("#goal-pct"),

   // Settings UI
    settingsBtn: $("#settings-btn"),
    settingsModal: $("#settings-modal"),
    settingsClose: $("#settings-close"),
    // Unified toggle + select + label
    appearanceMode: $("#appearance-mode"),
    appearanceSelect: $("#appearance-select"),
    appearanceLabel: $("#appearance-label"),
    // Keep background sliders
    bgOpacity: $("#bg-opacity"),
    bgBlur: $("#bg-blur"),
    editorDim: $("#dim-editor"),
    // Buttons inside modal
    settingsDone: $("#settings-done"),
    settingsReset: $("#settings-reset"),
    // Lore editor UI
    loreEditor: $("#lore-editor"),
    loreSwitchBtn: $("#switch-to-lore-btn"),
    loreBackBtn: $("#lore-back-btn"),
  loreBody: $("#lore-body"),
  loreKind: $("#lore-kind-input"),
  loreTitle: $("#lore-title-input"),
  loreTags: $("#lore-tags"),
  loreSummary: $("#lore-summary"),
  // Custom paired fields (entryNname / entryNcontent)
  entry1name: $("#entry1name"),
  entry1content: $("#entry1content"),
  entry2name: $("#entry2name"),
  entry2content: $("#entry2content"),
  entry3name: $("#entry3name"),
  entry3content: $("#entry3content"),
  entry4name: $("#entry4name"),
  entry4content: $("#entry4content"),
  tabsWriting: document.querySelector('.tabs-writing'),
  tabsLore: document.querySelector('.tabs-lore'),
  // Top-level app tabs (Story / Lore / Timeline)
  topTabs: document.querySelector('.top-tabs'),
  topTabButtons: document.querySelectorAll('.top-tabs .top-tab'),
  timeline: document.getElementById('timeline'),
  timelineCanvas: document.getElementById('timeline-canvas'),
  };

  // In-memory nodes placed on the timeline (keyed by a generated node id)
  state.timelineNodes = {}; // { nodeId: { entryId, x, y, color } }

  // Timeline viewport: logical scale and translation (in screen pixels)
  state.timelineViewport = { scale: 1, tx: 0, ty: 0 };

  // Timeline config
  const TIMELINE = {
    grid: 6, // pixels (finer snap for smoother movement)
    palette: [ '#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#0A84FF', '#5856D6', '#AF52DE' ],
    jitter: 8 // hue/saturation jitter amount
  };

  // Utility: pick base color from palette (by entry id hash) and jitter slightly
  function pickColorForEntry(entry) {
    try {
      const hash = String(entry.id || entry.code || entry.title || Math.random()).split("").reduce((a,c)=>a+ c.charCodeAt(0),0);
      const base = TIMELINE.palette[Math.abs(hash) % TIMELINE.palette.length];
      // Convert hex -> hsl, jitter, back to hex (simple approach)
      const rgb = hexToRgb(base);
      if (!rgb) return base;
      // apply small random jitter using entry id for determinism
      const rnd = (n) => Math.floor((Math.abs(hash + n) % 100) / 100 * TIMELINE.jitter) - (TIMELINE.jitter/2);
      const r = clamp(rgb.r + rnd(1), 30, 230);
      const g = clamp(rgb.g + rnd(2), 30, 230);
      const b = clamp(rgb.b + rnd(3), 30, 230);
      return rgbToHex(r,g,b);
    } catch (e) { return TIMELINE.palette[0]; }
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function hexToRgb(hex) {
    if (!hex) return null;
    const h = hex.replace('#','');
    if (h.length === 3) {
      return { r: parseInt(h[0]+h[0],16), g: parseInt(h[1]+h[1],16), b: parseInt(h[2]+h[2],16) };
    }
    return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) };
  }
  function rgbToHex(r,g,b){ return '#'+ [r,g,b].map(x => x.toString(16).padStart(2,'0')).join(''); }

  // Ensure timeline canvas exists after DOMContentLoaded (some HTML may be injected later)
  function ensureTimelineCanvas() {
    if (!el.timelineCanvas) el.timelineCanvas = document.getElementById('timeline-canvas');
    // Initialize box select handlers when canvas is first found
    if (el.timelineCanvas) {
      _installBoxSelectHandlers(el.timelineCanvas);
    }
    return el.timelineCanvas;
  }

  function setTimelineTransform() {
    const canvas = ensureTimelineCanvas();
    if (!canvas) return;
    const { scale, tx, ty } = state.timelineViewport;
    canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  // Convert a screen/client coordinate to canvas logical coordinates (accounting for transform)
  function clientToCanvas(clientX, clientY) {
    const canvas = ensureTimelineCanvas();
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const { scale } = state.timelineViewport;
    const lx = (clientX - rect.left) / (scale || 1);
    const ly = (clientY - rect.top) / (scale || 1);
    return { x: lx, y: ly };
  }

  // Links model: store link objects and render them in an SVG overlay
  state.timelineLinks = {}; // { linkId: { from: nodeId, to: nodeId } }
  // Selection model: ids of nodes currently selected (for box-select / group-move)
  state.timelineSelection = { ids: [] };

  function ensureTimelineSVG() {
    const canvas = ensureTimelineCanvas();
    if (!canvas) return null;
    let svg = canvas.querySelector('svg.timeline-svg');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.classList.add('timeline-svg', 'interactive');
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '100%');
      svg.setAttribute('preserveAspectRatio', 'none');
      canvas.insertBefore(svg, canvas.firstChild);
    }
    return svg;
  }

  function getNodeElement(nodeId) {
    const canvas = ensureTimelineCanvas();
    if (!canvas) return null;
    return canvas.querySelector(`[data-node-id="${nodeId}"]`);
  }

  // Compute logical canvas position for a specific handle id by locating the
  // handle DOM element and converting its client center to canvas coords.
  function getHandlePositionOfNode(handleId) {
    try {
      if (!handleId) return null;
      const el = document.querySelector(`[data-handle-id="${handleId}"]`);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      return clientToCanvas(cx, cy);
    } catch (e) {
      dbg('getHandlePositionOfNode error: ' + (e && e.message));
      return null;
    }
  }

  function drawLinkPath(svg, fromPt, toPt, cls = 'link') {
    // wrapper to create an SVG path element from a precomputed d string
    const d = computeLinkD(fromPt, toPt, { x: 0, y: 0 });
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.classList.add(cls);
    return path;
  }

  // Compute the cubic-bezier path `d` string for a link between two points.
  // cpOffset translates both control points (does not move anchors) so the
  // overall curve shape can be shifted without moving endpoints.
  function computeLinkD(fromPt, toPt, cpOffset) {
    cpOffset = cpOffset || { x: 0, y: 0 };
    const dx = Math.max(60, Math.abs(toPt.x - fromPt.x));
    let c1x = fromPt.x + dx * 0.35;
    let c1y = fromPt.y;
    let c2x = toPt.x - dx * 0.35;
    let c2y = toPt.y;
    c1x += cpOffset.x; c1y += cpOffset.y;
    c2x += cpOffset.x; c2y += cpOffset.y;
    return `M ${fromPt.x} ${fromPt.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${toPt.x} ${toPt.y}`;
  }

  function renderAllLinks() {
    const svg = ensureTimelineSVG();
    if (!svg) return;
    dbg(`timeline: renderAllLinks count=${Object.keys(state.timelineLinks || {}).length}`);
    // clear existing persistent paths
    svg.querySelectorAll('path.link').forEach(p => p.remove());


    for (const lid in state.timelineLinks) {
      const ln = state.timelineLinks[lid];
      const a = getHandlePositionOfNode(ln.fromHandle || ln.fromNode);
      const b = getHandlePositionOfNode(ln.toHandle || ln.toNode);
      if (!a || !b) continue;
      const cp = ln.cpOffset || { x: 0, y: 0 };
      const d = computeLinkD(a, b, cp);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.classList.add('link');
      // Make interactive for dragging
      path.classList.add('interactive');
      path.dataset.linkId = lid;
      svg.appendChild(path);


    }
  }

  function getNodeCenterRight(nodeId) {
    try {
      const el = getNodeElement(nodeId);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width;
      const cy = rect.top + rect.height / 2;
      return clientToCanvas(cx, cy);
    } catch (e) { return null; }
  }

  // Temporary drag state for creating a link
  let _tempLink = { active: false, svgPath: null, fromNode: null, fromHandle: null };
  // Drag state for moving an existing link's control points as a unit
  let _dragLink = { active: false, linkId: null, startCanvas: null, startOffset: null };
  // Connection editing state (for detach/reconnect)
  let _editLink = { active: false, linkId: null, fromNode: null, fromHandle: null, toNode: null, toHandle: null };
  // Box-selection state and group-drag state
  let _boxSelect = { active: false, rectEl: null, startCanvas: null };
  let _groupDrag = { active: false, nodeIds: [], startClientX: 0, startClientY: 0, startPositions: {} };

  // Clear timeline selection
  function clearTimelineSelection() {
    try {
      // Clear previous selection classes
      if (state.timelineSelection && Array.isArray(state.timelineSelection.ids)) {
        for (const id of state.timelineSelection.ids) {
          const el = getNodeElement(id);
          if (el) el.classList.remove('multi-selected');
        }
      }
      // Reset selection state
      state.timelineSelection.ids = [];
    } catch (e) { 
      dbg('clearTimelineSelection error: ' + (e && e.message)); 
    }
  }

  // Debug function to check current selection state
  function debugTimelineSelection() {
    try {
      const selectionIds = (state.timelineSelection && state.timelineSelection.ids) || [];
      dbg(`DEBUG-SELECTION: Current selection has ${selectionIds.length} nodes: [${selectionIds.join(', ')}]`);
      
      // Check if nodes actually have the multi-selected class
      for (const nodeId of selectionIds) {
        const el = getNodeElement(nodeId);
        if (el) {
          const hasClass = el.classList.contains('multi-selected');
          dbg(`DEBUG-SELECTION: Node ${nodeId} element found, multi-selected class: ${hasClass}`);
        } else {
          dbg(`DEBUG-SELECTION: Node ${nodeId} element NOT FOUND`);
        }
      }
      
      // Check all nodes for selection state
      const allNodeIds = Object.keys(state.timelineNodes || {});
      for (const nodeId of allNodeIds) {
        const el = getNodeElement(nodeId);
        if (el && el.classList.contains('multi-selected')) {
          dbg(`DEBUG-SELECTION: Found multi-selected node in DOM: ${nodeId}`);
        }
      }
    } catch (e) {
      dbg(`debugTimelineSelection error: ${e && e.message}`);
    }
  }

  // Make debug function available globally for console access
  window.debugTimelineSelection = debugTimelineSelection;

  // Helpers to manage handles per-node
  function addHandleToNode(nodeId, used, side = 'right') {
    try {
      if (!state.timelineNodes[nodeId]) state.timelineNodes[nodeId] = { entryId: null, x: 0, y: 0, color: null, handles: [] };
      const hid = `h-${uid()}`;
      state.timelineNodes[nodeId].handles = state.timelineNodes[nodeId].handles || [];
      const obj = { id: hid, used: !!used, side: side };
      state.timelineNodes[nodeId].handles.push(obj);
      // Create DOM element for handle
      const nodeEl = getNodeElement(nodeId);
      if (nodeEl) {
        const hEl = document.createElement('div');
        hEl.className = 'conn-handle';
        hEl.dataset.handleId = hid;
        hEl.dataset.side = side;
        hEl.classList.add(side);
        hEl.title = 'Create link';
        nodeEl.appendChild(hEl);
        updateHandlesForNode(nodeId);
      }
      dbg(`timeline: addHandleToNode node=${nodeId} handle=${hid} used=${!!used}`);
      return hid;
    } catch (e) { dbg('addHandleToNode error: ' + (e && e.message)); return null; }
  }

  function updateHandlesForNode(nodeId) {
    try {
      const nodeEl = getNodeElement(nodeId);
      if (!nodeEl) return;
      const handles = (state.timelineNodes[nodeId] && state.timelineNodes[nodeId].handles) || [];
      const els = Array.from(nodeEl.querySelectorAll('.conn-handle'));
      // Remove orphaned DOM handles that don't exist in state
      els.forEach(el => {
        const hid = el.dataset.handleId;
        if (!handles.find(h => h.id === hid)) {
          el.remove();
        }
      });
      // Add missing DOM elements
      for (const h of handles) {
        if (!els.find(e => e.dataset.handleId === h.id)) {
          const hEl = document.createElement('div');
          hEl.className = 'conn-handle';
          hEl.dataset.handleId = h.id;
          hEl.dataset.side = h.side || 'right';
          hEl.classList.add(h.side || 'right');
          hEl.title = 'Create link';
          nodeEl.appendChild(hEl);
        }
      }
      // Re-query and group by side
      const finalEls = Array.from(nodeEl.querySelectorAll('.conn-handle'));
      // Adjust node min-height so handles on either side don't overlap.
      try {
        const leftCount = handles.filter(h => (h.side || 'right') === 'left').length;
        const rightCount = handles.filter(h => (h.side || 'right') === 'right').length;
        const maxCount = Math.max(leftCount, rightCount, 1);
        const base = 40; // base min height in px
        const spacing = 20; // px per handle row
        nodeEl.style.minHeight = `${Math.max(base, Math.round(base + (maxCount - 1) * spacing))}px`;
      } catch (e) { /* best-effort */ }
      const sides = ['left','right'];
      for (const side of sides) {
        const sideHandles = handles.filter(h => (h.side || 'right') === side);
        const sideEls = finalEls.filter(e => (e.dataset.side || 'right') === side);
        const count = Math.max(sideHandles.length, sideEls.length);
        for (let i = 0; i < sideEls.length; i++) {
          const el = sideEls[i];
          // distribute vertically within side group
          const topPct = ((i + 1) / (count + 1)) * 100;
          el.style.top = `${topPct}%`;
          const hid = el.dataset.handleId;
          const hObj = handles.find(h => h.id === hid) || { used: false, side };
          el.classList.toggle('used', !!hObj.used);
          el.dataset.side = hObj.side || side;
          el.classList.remove('left','right');
          el.classList.add(hObj.side || side);
        }
      }
    } catch (e) { dbg('updateHandlesForNode error: ' + (e && e.message)); }
  }

  function startLinkDrag(fromNodeId, fromHandleId) {
    const svg = ensureTimelineSVG();
    if (!svg) return;
    
    // Only reset edit state if we're not currently in an edit operation
    if (!_editLink.active) {
      _editLink.linkId = null;
      _editLink.fromNode = null;
      _editLink.fromHandle = null;
      _editLink.toNode = null;
      _editLink.toHandle = null;
    }
    
    _tempLink.active = true;
    _tempLink.fromNode = fromNodeId;
    _tempLink.fromHandle = fromHandleId || null;
    if (_tempLink.svgPath) try { _tempLink.svgPath.remove(); } catch(e){}
    _tempLink.svgPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    _tempLink.svgPath.classList.add('temp');
    svg.appendChild(_tempLink.svgPath);
    dbg(`timeline: startLinkDrag fromNode=${fromNodeId} fromHandle=${_tempLink.fromHandle || '<none>'}`);
  }

  function updateTempLink(clientX, clientY) {
    if (!_tempLink.active || !_tempLink.svgPath) return;
    // Prefer the explicit handle position if we started from a handle, otherwise
    // fall back to the center-right of the originating node (obscure case).
  let fromPos = null;
  if (_tempLink.fromHandle) fromPos = getHandlePositionOfNode(_tempLink.fromHandle);
  if (!fromPos && _tempLink.fromNode) fromPos = getNodeCenterRight(_tempLink.fromNode);
    if (!fromPos) return;
    const toPos = clientToCanvas(clientX, clientY);
    const d = computeLinkD(fromPos, toPos, { x: 0, y: 0 });
    _tempLink.svgPath.setAttribute('d', d);
    dbg(`timeline: updateTempLink from=${_tempLink.fromNode || '<unknown>'} fromHandle=${_tempLink.fromHandle || '<none>'} toClient=${clientX},${clientY} toCanvas=${Math.round(toPos.x)},${Math.round(toPos.y)}`);
  }

  function finishLinkDrag(clientX, clientY, targetNodeId, targetHandleId) {
    if (!_tempLink.active) return;
    try { if (_tempLink.svgPath) _tempLink.svgPath.remove(); } catch (e) {}
    _tempLink.active = false;
    const fromNode = _tempLink.fromNode;
    const fromHandle = _tempLink.fromHandle || null;
    _tempLink.fromNode = null;
    _tempLink.fromHandle = null;
    dbg(`timeline: finishLinkDrag fromNode=${fromNode} fromHandle=${fromHandle} targetNode=${targetNodeId} targetHandle=${targetHandleId} client=${clientX},${clientY}`);
    if (!fromNode) return;
    
    if (!targetNodeId || targetNodeId === fromNode) {
      dbg('timeline: finishLinkDrag ignored (no valid target or self-link)');
      return; // ignore invalid
    }
    // Require both a valid source handle (we started from a handle) and a
    // target handle (user must drop on a connection point). Otherwise ignore.
    if (!fromHandle) {
      dbg('timeline: finishLinkDrag ignored - no source handle recorded');
      return;
    }
    if (!targetHandleId) {
      dbg('timeline: finishLinkDrag ignored - no target handle (must drop on a handle)');
      return;
    }

    // Disallow creating a link if either source or target handle is already used
    try {
      const srcNode = state.timelineNodes[fromNode];
      const dstNode = state.timelineNodes[targetNodeId];
      const srcH = srcNode && srcNode.handles && srcNode.handles.find(h => h.id === fromHandle);
      const dstH = dstNode && dstNode.handles && dstNode.handles.find(h => h.id === targetHandleId);
      if (srcH && srcH.used) {
        dbg(`timeline: finishLinkDrag ignored - source handle already used ${fromHandle} on node ${fromNode}`);
        return;
      }
      if (dstH && dstH.used) {
        dbg(`timeline: finishLinkDrag ignored - target handle already used ${targetHandleId} on node ${targetNodeId}`);
        return;
      }
    } catch (e) { dbg('finishLinkDrag used-handle check error: ' + (e && e.message)); }

    const srcHandle = fromHandle;
    const dstHandle = targetHandleId;
    const lid = `ln-${uid()}`;
  state.timelineLinks[lid] = { fromNode, fromHandle: srcHandle, toNode: targetNodeId, toHandle: dstHandle, cpOffset: { x: 0, y: 0 } };
    dbg(`timeline: link created ${lid} ${fromNode}:${srcHandle} -> ${targetNodeId}:${dstHandle}`);

    // Mark both source and target handles used and append new empty handles on the same sides
    try {
      // source
      if (srcHandle && state.timelineNodes[fromNode]) {
        const h = state.timelineNodes[fromNode].handles.find(h => h.id === srcHandle);
        const srcSide = h && h.side ? h.side : 'right';
        if (h) { h.used = true; dbg(`timeline: handle consumed ${srcHandle} on node ${fromNode}`); }
        
        // Only add new empty handle if there aren't enough unused handles on this side
        const handles = state.timelineNodes[fromNode].handles || [];
        const sameSideUnused = handles.filter(handle => handle.side === srcSide && !handle.used);
        if (sameSideUnused.length === 0) {
          const newH = addHandleToNode(fromNode, false, srcSide);
          dbg(`timeline: appended new empty handle ${newH} to node ${fromNode} side=${srcSide}`);
        } else {
          dbg(`timeline: no new handle needed for node ${fromNode} side=${srcSide} (${sameSideUnused.length} unused handles available)`);
        }
      }
      // target
      if (dstHandle && state.timelineNodes[targetNodeId]) {
        const h2 = state.timelineNodes[targetNodeId].handles.find(h => h.id === dstHandle);
        const dstSide = h2 && h2.side ? h2.side : 'left';
        if (h2) { h2.used = true; dbg(`timeline: handle consumed ${dstHandle} on node ${targetNodeId}`); }
        
        // Only add new empty handle if there aren't enough unused handles on this side
        const handles2 = state.timelineNodes[targetNodeId].handles || [];
        const sameSideUnused2 = handles2.filter(handle => handle.side === dstSide && !handle.used);
        if (sameSideUnused2.length === 0) {
          const newH2 = addHandleToNode(targetNodeId, false, dstSide);
          dbg(`timeline: appended new empty handle ${newH2} to node ${targetNodeId} side=${dstSide}`);
        } else {
          dbg(`timeline: no new handle needed for node ${targetNodeId} side=${dstSide} (${sameSideUnused2.length} unused handles available)`);
        }
      }
    } catch (e) { dbg('finishLinkDrag handle update error: ' + (e && e.message)); }

    // If this was a connection edit, log handle states of all involved nodes AFTER handles are updated
    dbg(`timeline: FINISHLINKDRAG - checking edit context: ${window._editContext ? 'exists' : 'null'}`);
    if (window._editContext && window._editContext.active) {
      const sourceNode = window._editContext.sourceNode;
      const originalTargetNode = window._editContext.originalTargetNode;
      const newTargetNode = window._editContext.newTargetNode;
      
      dbg(`timeline: EDIT COMPLETE - logging handle states for all involved nodes AFTER handle updates`);
      
      // Log source node handle state
      const sourceHandles = state.timelineNodes[sourceNode]?.handles || [];
      dbg(`timeline: EDIT COMPLETE - SOURCE node ${sourceNode}: ${sourceHandles.length} handles: ${sourceHandles.map(h => `${h.id}(${h.used?'used':'unused'})`).join(', ')}`);
      
      // Log original target node handle state (if different from new target)
      if (originalTargetNode && originalTargetNode !== newTargetNode) {
        const originalTargetHandles = state.timelineNodes[originalTargetNode]?.handles || [];
        dbg(`timeline: EDIT COMPLETE - ORIGINAL TARGET node ${originalTargetNode}: ${originalTargetHandles.length} handles: ${originalTargetHandles.map(h => `${h.id}(${h.used?'used':'unused'})`).join(', ')}`);
      }
      
      // Log new target node handle state
      const newTargetHandles = state.timelineNodes[newTargetNode]?.handles || [];
      dbg(`timeline: EDIT COMPLETE - NEW TARGET node ${newTargetNode}: ${newTargetHandles.length} handles: ${newTargetHandles.map(h => `${h.id}(${h.used?'used':'unused'})`).join(', ')}`);
      
      // Clear the edit context
      window._editContext = null;
    }

    renderAllLinks();
    touchSave(); // Save timeline changes
    // Also immediately save timeline data to ensure persistence
    try { saveToDisk(); } catch (e) { dbg('timeline: immediate save after node removal failed: ' + (e?.message || e)); }
  }

  // ─────────────── Timeline Save/Load ───────────────
  function saveTimelineData() {
    if (!SAVE_FILE || !path || !fs) return;
    
    try {
      const timelineFile = path.join(path.dirname(SAVE_FILE), 'timeline.json');
      
      dbg(`timeline: saveTimelineData - starting save to ${timelineFile}`);
      dbg(`timeline: saveTimelineData - current state: nodes=${Object.keys(state.timelineNodes || {}).length} links=${Object.keys(state.timelineLinks || {}).length}`);
      
      // Clean up any stale links before saving
      cleanupStaleLinks();
      
      // Build timeline data structure with proper metadata
      // Generate timeline ID and code if they don't exist
      if (!state.timeline) {
        state.timeline = {};
      }
      
      // Generate timeline ID and code if they don't exist
      if (!state.timeline.id) {
        // Generate numeric ID (like other entities)
        state.timeline.id = 1; // First timeline for project
      }
      
      // Fix legacy string IDs - force conversion to numeric BEFORE creating timelineData
      if (typeof state.timeline.id === 'string') {
        state.timeline.id = 1;
        dbg(`timeline: saveTimelineData - converted legacy string id to numeric: ${state.timeline.id}`);
        // Force immediate save to update the workspace file
        state.dirty = true;
      }
      
      // Generate timeline code using project ID (like TMLPRJ-0001-000001)
      if (!state.timeline.code) {
        const projectId = state.project?.id || 1;
        const projectStr = String(projectId).padStart(4, '0');
        state.timeline.code = `TMLPRJ-${projectStr}-000001`;
      }
      
      const timelineData = {
        id: state.timeline.id,  // This should now be numeric
        code: state.timeline.code,
        title: state.timeline.title || `${state.projectName || 'Project'} Timeline`,
        description: state.timeline.description || 'Project timeline visualization',
        nodes: {},
        links: {}
      };
      
      // Convert nodes to use entry codes
      for (const [nodeId, nodeData] of Object.entries(state.timelineNodes || {})) {
        if (!nodeData.entryId) {
          dbg(`timeline: saveTimelineData - skipping node ${nodeId} - no entryId`);
          continue;
        }
        
        // Find the entry using entryKey lookup
        dbg(`timeline: saveTimelineData - looking up entry for nodeData.entryId=${nodeData.entryId}`);
        const entry = findEntryByKey(nodeData.entryId);
        if (!entry || !entry.code) {
          dbg(`timeline: saveTimelineData - skipping node ${nodeId} - entry not found or no code. entryId=${nodeData.entryId} found=${!!entry} code=${entry?.code}`);
          continue;
        }
        dbg(`timeline: saveTimelineData - found entry for node ${nodeId}: code=${entry.code} type=${entry.type} title=${entry.title}`);
        
        timelineData.nodes[nodeId] = {
          entryCode: entry.code,
          x: nodeData.x || 0,
          y: nodeData.y || 0,
          color: nodeData.color || null,
          handles: nodeData.handles || []
        };
      }
      
      // Copy links directly, but only if both nodes exist
      for (const [linkId, linkData] of Object.entries(state.timelineLinks || {})) {
        // Verify both nodes exist in current timeline
        if (!state.timelineNodes[linkData.fromNode] || !state.timelineNodes[linkData.toNode]) {
          dbg(`timeline: saveTimelineData - skipping link ${linkId} - missing nodes (from: ${linkData.fromNode} exists: ${!!state.timelineNodes[linkData.fromNode]}, to: ${linkData.toNode} exists: ${!!state.timelineNodes[linkData.toNode]})`);
          continue;
        }
        
        timelineData.links[linkId] = {
          fromNode: linkData.fromNode,
          fromHandle: linkData.fromHandle,
          toNode: linkData.toNode,
          toHandle: linkData.toHandle,
          cpOffset: linkData.cpOffset || { x: 0, y: 0 }
        };
        dbg(`timeline: saveTimelineData - saving link ${linkId}: ${linkData.fromNode} -> ${linkData.toNode}`);
      }
      
      dbg(`timeline: saveTimelineData - about to write file with ${Object.keys(timelineData.nodes).length} nodes, ${Object.keys(timelineData.links).length} links`);
      dbg(`timeline: saveTimelineData - timeline data preview: ${JSON.stringify(timelineData, null, 2).slice(0, 500)}...`);
      
      fs.writeFileSync(timelineFile, JSON.stringify(timelineData, null, 2), 'utf8');
      dbg(`timeline: saved ${Object.keys(timelineData.nodes).length} nodes and ${Object.keys(timelineData.links).length} links to ${timelineFile}`);
    } catch (e) {
      dbg(`timeline: save failed: ${e?.message || e}`);
    }
  }
  
  function loadTimelineData() {
    if (!SAVE_FILE || !path || !fs) return;
    
    // Always clear existing timeline data first
    clearTimelineData();
    
    try {
      const timelineFile = path.join(path.dirname(SAVE_FILE), 'timeline.json');
      if (!fs.existsSync(timelineFile)) {
        dbg('timeline: no timeline.json found, timeline cleared');
        return;
      }
      
      const data = JSON.parse(fs.readFileSync(timelineFile, 'utf8'));
      dbg(`timeline: loading ${Object.keys(data.nodes || {}).length} nodes and ${Object.keys(data.links || {}).length} links`);
      
      // Restore timeline metadata
      if (!state.timeline) state.timeline = {};
      state.timeline.id = data.id || state.timeline.id;
      state.timeline.code = data.code || state.timeline.code;
      state.timeline.title = data.title || state.timeline.title;
      state.timeline.description = data.description || state.timeline.description;
      
      // Fix legacy timeline format: ensure id is numeric
      if (typeof state.timeline.id === 'string') {
        state.timeline.id = 1; // Convert string id to numeric
        dbg(`timeline: converted legacy string id to numeric: ${state.timeline.id}`);
      }
      
      // Track node ID mapping from saved to actual (needed when IDs change)
      const nodeIdMapping = {};
      
      // Restore nodes
      for (const [savedNodeId, nodeData] of Object.entries(data.nodes || {})) {
        // Find entry by code
        const entry = state.entries.find(e => e.code === nodeData.entryCode);
        if (!entry) {
          dbg(`timeline: skipping node ${savedNodeId} - entry with code ${nodeData.entryCode} not found`);
          continue;
        }
        
        dbg(`timeline: loadTimelineData - recreating node ${savedNodeId} for entry code=${entry.code} type=${entry.type}`);
        
        // Create the timeline node but override the auto-generated ID with the saved one
        const actualNode = createTimelineNodeForEntryWithId(entry, nodeData.x, nodeData.y, savedNodeId, nodeData.color, nodeData.handles);
        if (actualNode) {
          nodeIdMapping[savedNodeId] = actualNode.nodeId;
          dbg(`timeline: loadTimelineData - mapped saved node ${savedNodeId} to actual node ${actualNode.nodeId}`);
        }
      }
      
      // Restore links with corrected node IDs
      for (const [linkId, linkData] of Object.entries(data.links || {})) {
        const fromNodeId = nodeIdMapping[linkData.fromNode] || linkData.fromNode;
        const toNodeId = nodeIdMapping[linkData.toNode] || linkData.toNode;
        
        // Only restore link if both nodes exist
        if (state.timelineNodes[fromNodeId] && state.timelineNodes[toNodeId]) {
          state.timelineLinks[linkId] = {
            ...linkData,
            fromNode: fromNodeId,
            toNode: toNodeId
          };
          dbg(`timeline: loadTimelineData - restored link ${linkId}: ${fromNodeId}:${linkData.fromHandle} -> ${toNodeId}:${linkData.toHandle}`);
        } else {
          dbg(`timeline: loadTimelineData - skipping link ${linkId} - missing nodes (from: ${fromNodeId} exists: ${!!state.timelineNodes[fromNodeId]}, to: ${toNodeId} exists: ${!!state.timelineNodes[toNodeId]})`);
        }
      }
      
      renderAllLinks();
      dbg('timeline: load completed successfully');
    } catch (e) {
      dbg(`timeline: load failed: ${e?.message || e}`);
    }
  }

  // Helper to remove a connection and clean up handles
  function removeConnection(linkId, skipAutoAddHandles = false) {
    try {
      const link = state.timelineLinks[linkId];
      if (!link) return;
      
      dbg(`timeline: removing connection ${linkId}`);
      
      // Free up the handles by marking them unused and removing them
      const srcNode = state.timelineNodes[link.fromNode];
      const dstNode = state.timelineNodes[link.toNode];
      
      if (srcNode && link.fromHandle) {
        const handles = srcNode.handles || [];
        const handleIdx = handles.findIndex(h => h.id === link.fromHandle);
        if (handleIdx >= 0) {
          const handleObj = handles[handleIdx];
          handles.splice(handleIdx, 1);
          dbg(`timeline: removed handle ${link.fromHandle} from node ${link.fromNode}`);
          
          // Only auto-add replacement handle if not in editing mode
          if (!skipAutoAddHandles) {
            const handleSide = handleObj.side || 'right';
            addHandleToNode(link.fromNode, false, handleSide);
            dbg(`timeline: added replacement handle to node ${link.fromNode} side=${handleSide}`);
          }
          
          updateHandlesForNode(link.fromNode);
        }
      }
      
      if (dstNode && link.toHandle) {
        const handles = dstNode.handles || [];
        const handleIdx = handles.findIndex(h => h.id === link.toHandle);
        if (handleIdx >= 0) {
          const handleObj = handles[handleIdx];
          handles.splice(handleIdx, 1);
          dbg(`timeline: removed handle ${link.toHandle} from node ${link.toNode}`);
          
          // Only auto-add replacement handle if not in editing mode
          if (!skipAutoAddHandles) {
            const handleSide = handleObj.side || 'left';
            addHandleToNode(link.toNode, false, handleSide);
            dbg(`timeline: added replacement handle to node ${link.toNode} side=${handleSide}`);
          }
          
          updateHandlesForNode(link.toNode);
        }
      }
      
      // Remove the link itself
      delete state.timelineLinks[linkId];
      renderAllLinks();
      touchSave(); // Save timeline changes
      // Also immediately save timeline data to ensure persistence
      try { saveToDisk(); } catch (e) { dbg('timeline: immediate save after link removal failed: ' + (e?.message || e)); }
    } catch (e) {
      dbg('removeConnection error: ' + (e && e.message));
    }
  }

  // Selection helpers (box-select + group move)
  function clearTimelineSelection() {
    try {
      const prev = state.timelineSelection && state.timelineSelection.ids ? state.timelineSelection.ids : [];
      for (const id of prev) {
        const el = getNodeElement(id);
        if (el) el.classList.remove('multi-selected');
      }
    } catch (e) { /* best-effort */ }
    state.timelineSelection = { ids: [] };
    // hide rect if present
    try { if (_boxSelect.rectEl) _boxSelect.rectEl.classList.remove('visible'); } catch (e) {}
  }
  
  function clearTimelineData() {
    dbg('timeline: clearing all timeline data');
    // Clear state
    state.timelineNodes = {};
    state.timelineLinks = {};
    state.timelineSelection.ids = [];
    state.timeline = {}; // Clear timeline metadata
    
    // Clear DOM
    const canvas = ensureTimelineCanvas();
    if (canvas) {
      canvas.querySelectorAll('.timeline-node').forEach(n => n.remove());
      // Clear any existing SVG links
      const existingSvg = canvas.querySelector('svg');
      if (existingSvg) {
        existingSvg.remove();
      }
    }
  }

  function selectAllTimelineNodes() {
    const ids = Object.keys(state.timelineNodes || {});
    state.timelineSelection.ids = ids.slice();
    for (const id of ids) {
      const el = getNodeElement(id);
      if (el) el.classList.add('multi-selected');
    }
  }

  function _installBoxSelectHandlers(canvas) {
    if (!canvas) return;
    if (canvas.dataset.tlBoxSelectInstalled) return;
    canvas.dataset.tlBoxSelectInstalled = '1';

    // ensure selection rect element exists
    if (!_boxSelect.rectEl) {
      const r = document.createElement('div');
      r.className = 'timeline-selection-rect';
      r.style.position = 'absolute';
      r.style.left = '0px'; r.style.top = '0px'; r.style.width = '0px'; r.style.height = '0px';
      r.style.pointerEvents = 'none';
      canvas.appendChild(r);
      _boxSelect.rectEl = r;
    }

    canvas.addEventListener('pointerdown', (ev) => {
      try {
        if (ev.button !== 0) return; // left only
        // If user clicked on a node, handle, link path, or interactive control, don't start box-select here
        const tgt = ev.target && ev.target.closest ? ev.target.closest('.timeline-node, .conn-handle, .color-btn, .color-panel') : null;
        if (tgt) return;
        // Ignore pointerdown on SVG link paths (they use .link/.interactive)
        const linkHit = ev.target && ev.target.closest ? ev.target.closest('path.link, .link, path.temp, .temp') : null;
        if (linkHit) {
          dbg('box-select: pointerdown ignored on SVG link path');
          return;
        }
        // Start box select
        ev.preventDefault();
        _boxSelect.active = true;
        _boxSelect.startCanvas = clientToCanvas(ev.clientX, ev.clientY);
        const r = _boxSelect.rectEl;
        if (r) {
          r.classList.add('visible');
          r.style.left = `${_boxSelect.startCanvas.x}px`;
          r.style.top = `${_boxSelect.startCanvas.y}px`;
          r.style.width = '0px'; r.style.height = '0px';
        }
      } catch (e) { dbg('box select start error: ' + (e && e.message)); }
    });

    window.addEventListener('pointermove', (ev) => {
      try {
        if (!_boxSelect.active) return;
        ev.preventDefault();
        const cur = clientToCanvas(ev.clientX, ev.clientY);
        const sx = Math.min(_boxSelect.startCanvas.x, cur.x);
        const sy = Math.min(_boxSelect.startCanvas.y, cur.y);
        const w = Math.abs(cur.x - _boxSelect.startCanvas.x);
        const h = Math.abs(cur.y - _boxSelect.startCanvas.y);
        const r = _boxSelect.rectEl;
        if (r) {
          r.style.left = `${sx}px`;
          r.style.top = `${sy}px`;
          r.style.width = `${w}px`;
          r.style.height = `${h}px`;
        }
      } catch (e) { /* best-effort */ }
    });

    window.addEventListener('pointerup', (ev) => {
      try {
        if (!_boxSelect.active) return;
        _boxSelect.active = false;
        const r = _boxSelect.rectEl;
        if (!r) return;
        // compute selection rect in canvas logical coords
        const rx = parseFloat(r.style.left || 0);
        const ry = parseFloat(r.style.top || 0);
        const rw = parseFloat(r.style.width || 0);
        const rh = parseFloat(r.style.height || 0);
        // clear previous selection
        clearTimelineSelection();
        dbg(`box-select: starting selection in rect (${rx}, ${ry}, ${rw}, ${rh})`);
        const ids = [];
        for (const nid in state.timelineNodes) {
          try {
            const nodeEl = getNodeElement(nid);
            if (!nodeEl) continue;
            const nx = parseInt(nodeEl.style.left || 0, 10);
            const ny = parseInt(nodeEl.style.top || 0, 10);
            const nw = nodeEl.offsetWidth || 0;
            const nh = nodeEl.offsetHeight || 0;
            // Intersect test in logical coords
            const overlap = !(nx + nw < rx || nx > rx + rw || ny + nh < ry || ny > ry + rh);
            dbg(`box-select: node ${nid} at (${nx}, ${ny}, ${nw}, ${nh}) overlap=${overlap}`);
            if (overlap) {
              ids.push(nid);
            }
          } catch (e) { dbg(`box-select: error checking node ${nid}: ${e?.message}`); }
        }
        state.timelineSelection.ids = ids;
        dbg(`box-select: COMPLETED - selected ${ids.length} nodes: [${ids.join(', ')}]`);
        for (const id of ids) {
          const el = getNodeElement(id);
          if (el) {
            el.classList.add('multi-selected');
            dbg(`box-select: added multi-selected class to node ${id}`);
          } else {
            dbg(`box-select: WARNING - could not find element for selected node ${id}`);
          }
        }
        // Debug the final selection state
        setTimeout(() => debugTimelineSelection(), 100);
        // hide rectangle
        r.classList.remove('visible');
      } catch (e) { dbg('box select finish error: ' + (e && e.message)); }
    });
  }

  // Zoom helper: keep the logical point under (clientX,clientY) stable when scaling
  function setTimelineScale(newScale, clientX, clientY) {
    const canvas = ensureTimelineCanvas();
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const old = state.timelineViewport;
    const s0 = old.scale;
    const s1 = Math.max(0.25, Math.min(4, newScale));
    // Compute logical coordinate of client point
    const lx = (clientX - rect.left) / s0;
    const ly = (clientY - rect.top) / s0;
    // New tx/ty such that lx maps to same client point
    const ntx = clientX - rect.left - lx * s1;
    const nty = clientY - rect.top - ly * s1;
    state.timelineViewport.scale = s1;
    state.timelineViewport.tx = Math.round(ntx);
    state.timelineViewport.ty = Math.round(nty);
    // Clamp pan so transformed canvas stays inside its container
    clampTimelinePan();
    setTimelineTransform();
  }

  function clampTimelinePan() {
    try {
      const canvas = ensureTimelineCanvas();
      if (!canvas) return;
      const container = canvas.parentElement || canvas.closest('.timeline') || document.body;
      const rect = container.getBoundingClientRect();
      const cw = canvas.clientWidth * (state.timelineViewport.scale || 1);
      const ch = canvas.clientHeight * (state.timelineViewport.scale || 1);
      const containerW = rect.width;
      const containerH = rect.height;

      // If content smaller than container, center it; otherwise clamp between [container - content, 0]
      let minTx, maxTx, minTy, maxTy;
      if (cw <= containerW) {
        minTx = maxTx = Math.round((containerW - cw) / 2);
      } else {
        minTx = Math.round(containerW - cw);
        maxTx = 0;
      }
      if (ch <= containerH) {
        minTy = maxTy = Math.round((containerH - ch) / 2);
      } else {
        minTy = Math.round(containerH - ch);
        maxTy = 0;
      }

      state.timelineViewport.tx = Math.min(maxTx, Math.max(minTx, state.timelineViewport.tx || 0));
      state.timelineViewport.ty = Math.min(maxTy, Math.max(minTy, state.timelineViewport.ty || 0));
    } catch (e) { dbg('clampTimelinePan error: ' + (e && e.message)); }
  }

  // Create a visual node for an entry at (x,y) (canvas coordinates)
  function createTimelineNodeForEntry(entry, x, y) {
    const canvas = ensureTimelineCanvas();
    if (!canvas) return null;
    dbg(`timeline: createTimelineNodeForEntry received entry=${entry?.id} x=${x} y=${y}`);

    const nodeId = `tn-${uid()}`;
    const color = pickColorForEntry(entry);

    const node = document.createElement('div');
    node.className = 'timeline-node';
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.style.background = color;
    node.dataset.nodeId = nodeId;
    node.dataset.entryId = entry.id;

    const label = document.createElement('div');
    label.className = 'node-label';
    label.textContent = entry.title || '(Untitled)';

    const kind = document.createElement('div');
    kind.className = 'node-kind';
    kind.textContent = entry.lore_kind || (entry.type || 'lore');

    const leftWrap = document.createElement('div');
    leftWrap.style.display = 'flex';
    leftWrap.style.flexDirection = 'column';
    leftWrap.appendChild(label);
    leftWrap.appendChild(kind);

    const remove = document.createElement('button');
    remove.className = 'remove-btn';
    remove.title = 'Remove from timeline';
    remove.textContent = '×';
    remove.addEventListener('click', (ev) => {
      ev.stopPropagation();
      removeTimelineNode(nodeId);
    });

  // NOTE: handles are created via addHandleToNode() which also manages state

    // Color picker control (inline, expands a small hue slider)
    const colorBtn = document.createElement('button');
    colorBtn.className = 'color-btn';
    colorBtn.title = 'Change color';
    colorBtn.textContent = '◐';

    const colorPanel = document.createElement('div');
    colorPanel.className = 'color-panel';

    const hueInput = document.createElement('input');
    hueInput.type = 'range';
    hueInput.min = 0; hueInput.max = 360; hueInput.step = 1;

    const swatch = document.createElement('span');
    swatch.className = 'color-swatch';

    colorPanel.appendChild(hueInput);
    colorPanel.appendChild(swatch);

    // helpers: HSL <-> HEX
    function hslToRgb(h, s, l) {
      s /= 100; l /= 100;
      const k = n => (n + h / 30) % 12;
      const a = s * Math.min(l, 1 - l);
      const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
      return { r: Math.round(255 * f(0)), g: Math.round(255 * f(8)), b: Math.round(255 * f(4)) };
    }
    function rgbToHex(r,g,b){ return '#'+ [r,g,b].map(x => x.toString(16).padStart(2,'0')).join(''); }
    function hexToRgbObj(hex) { const c = hex.replace('#',''); return { r: parseInt(c.slice(0,2),16), g: parseInt(c.slice(2,4),16), b: parseInt(c.slice(4,6),16) }; }
    function rgbToHsl(r,g,b){ r/=255; g/=255; b/=255; const max=Math.max(r,g,b), min=Math.min(r,g,b); let h=0,s=0,l=(max+min)/2; if(max!==min){ const d=max-min; s = l>0.5? d/(2-max-min) : d/(max+min); switch(max){ case r: h=(g-b)/d + (g<b?6:0); break; case g: h=(b-r)/d + 2; break; case b: h=(r-g)/d + 4; break; } h = Math.round(h*60); } return { h: h, s: Math.round(s*100), l: Math.round(l*100) } }

    // initialize color value (use stored if present)
    let initialHue = 220; // fallback
    try {
      const existing = state.timelineNodes && state.timelineNodes[nodeId] && state.timelineNodes[nodeId].color;
      if (existing) {
        // convert hex -> hsl
        const rgb = hexToRgbObj(existing);
        const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
        initialHue = Number.isFinite(hsl.h) ? hsl.h : initialHue;
      } else {
        // pick base color and derive hue
        const base = pickColorForEntry(entry);
        const rgb = hexToRgb(base);
        const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
        initialHue = Number.isFinite(hsl.h) ? hsl.h : initialHue;
      }
    } catch (e) { /* best-effort */ }

    hueInput.value = initialHue;
    const applyHue = (h) => {
      const rgb = hslToRgb(Number(h), 75, 50);
      const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
      node.style.background = hex;
      swatch.style.background = hex;
      // store in-memory
      state.timelineNodes[nodeId] = state.timelineNodes[nodeId] || {};
      state.timelineNodes[nodeId].color = hex;
      touchSave(); // Save timeline color changes
    };
    applyHue(initialHue);

    hueInput.addEventListener('input', (ev) => {
      ev.stopPropagation();
      applyHue(ev.target.value);
    });

    // toggle panel
    colorBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      colorPanel.classList.toggle('visible');
    });

    // close panel when clicking elsewhere
    document.addEventListener('click', (ev) => {
      try { if (!colorPanel.contains(ev.target) && !colorBtn.contains(ev.target)) colorPanel.classList.remove('visible'); } catch (e) {}
    });

    node.appendChild(leftWrap);
    node.appendChild(remove);

    // Pointer dragging for moving node
  let dragging = false;
  let start = { x: 0, y: 0 };
  let orig = { x: 0, y: 0 };
    node.addEventListener('pointerdown', (ev) => {
      // If pointerdown originated on the remove button or color controls,
      // don't start a node-drag; let those controls handle the event.
      try {
        if (ev.target && ev.target.closest) {
          if (ev.target.closest('.remove-btn') || ev.target.closest('.color-btn') || ev.target.closest('.color-panel') || ev.target.closest('.conn-handle')) return;
        }
      } catch (e) { /* best-effort */ }
  ev.preventDefault();
  node.setPointerCapture(ev.pointerId);
  const nodeId = node.dataset.nodeId;
      dbg(`node-drag: pointerdown on node ${nodeId}`);
      dbg(`node-drag: selection state - ids: [${(state.timelineSelection?.ids || []).join(', ')}]`);
      dbg(`node-drag: checking if node ${nodeId} is in selection: ${state.timelineSelection && Array.isArray(state.timelineSelection.ids) && state.timelineSelection.ids.includes(nodeId)}`);
      
      // If this node is part of the selection, start a group drag
      if (state.timelineSelection && Array.isArray(state.timelineSelection.ids) && state.timelineSelection.ids.includes(nodeId)) {
        dbg(`group-drag: STARTING group drag with ${state.timelineSelection.ids.length} nodes: [${state.timelineSelection.ids.join(', ')}]`);
        _groupDrag.active = true;
        _groupDrag.nodeIds = state.timelineSelection.ids.slice();
        _groupDrag.startClientX = ev.clientX;
        _groupDrag.startClientY = ev.clientY;
        _groupDrag.startPositions = {};
        for (const nid of _groupDrag.nodeIds) {
          const eln = getNodeElement(nid);
          if (eln) {
            const pos = { x: parseInt(eln.style.left || 0, 10), y: parseInt(eln.style.top || 0, 10) };
            _groupDrag.startPositions[nid] = pos;
            dbg(`group-drag: recorded start position for node ${nid}: (${pos.x}, ${pos.y})`);
          } else {
            dbg(`group-drag: WARNING - could not find element for node ${nid}`);
          }
        }
        // don't start single-node dragging
        return;
      }

      // Single-node drag (fallback)
      dbg(`single-node-drag: STARTING single node drag for ${nodeId}`);
      dragging = true;
      // store raw client start and precise origin (float) for free dragging
      start = { x: ev.clientX, y: ev.clientY };
      orig = { x: parseFloat(node.style.left || 0), y: parseFloat(node.style.top || 0) };
    });
    node.addEventListener('pointermove', (ev) => {
      if (_groupDrag.active) {
        ev.preventDefault();
        const s = state.timelineViewport.scale || 1;
        const dx = (ev.clientX - _groupDrag.startClientX) / s;
        const dy = (ev.clientY - _groupDrag.startClientY) / s;
        dbg(`group-drag: MOVING ${_groupDrag.nodeIds.length} nodes by delta (${Math.round(dx)}, ${Math.round(dy)})`);
        for (const nid of _groupDrag.nodeIds) {
          try {
            const pos = _groupDrag.startPositions[nid];
            if (!pos) {
              dbg(`group-drag: WARNING - no start position for node ${nid}`);
              continue;
            }
            // free-drag: do not snap while moving
            const nx = pos.x + dx;
            const ny = pos.y + dy;
            const eln = getNodeElement(nid);
            if (eln) {
              eln.style.left = `${nx}px`;
              eln.style.top = `${ny}px`;
              // dbg(`group-drag: moved node ${nid} to (${Math.round(nx)}, ${Math.round(ny)})`);
            } else {
              dbg(`group-drag: WARNING - could not find element for node ${nid}`);
            }
          } catch (e) { dbg(`group-drag: error moving node ${nid}: ${e?.message}`); }
        }
        try { renderAllLinks(); } catch (e) { dbg(`group-drag: error rendering links: ${e?.message}`); }
        return;
      }

      if (!dragging) return;
      ev.preventDefault();
      // Movement: free dragging (no per-frame snap), compute logical delta
      const s = state.timelineViewport.scale || 1;
      const dx = (ev.clientX - start.x) / s;
      const dy = (ev.clientY - start.y) / s;
      const nx = orig.x + dx;
      const ny = orig.y + dy;
      node.style.left = `${nx}px`;
      node.style.top = `${ny}px`;
      // update link visuals while dragging
      try { renderAllLinks(); } catch (e) { /* best-effort */ }
    });
    node.addEventListener('pointerup', (ev) => {
      // If group dragging, persist all moved nodes
      if (_groupDrag.active) {
        dbg(`group-drag: COMPLETING group drag for ${_groupDrag.nodeIds.length} nodes`);
        _groupDrag.active = false;
        try { node.releasePointerCapture(ev.pointerId); } catch (e) {}
        for (const nid of _groupDrag.nodeIds) {
          try {
            const eln = getNodeElement(nid);
            if (!eln) {
              dbg(`group-drag: WARNING - could not find element for node ${nid} during completion`);
              continue;
            }
            // snap to grid on drop
            const px = parseFloat(eln.style.left || 0);
            const py = parseFloat(eln.style.top || 0);
            const sx = snapToGrid(px, TIMELINE.grid);
            const sy = snapToGrid(py, TIMELINE.grid);
            eln.style.left = `${sx}px`;
            eln.style.top = `${sy}px`;
            state.timelineNodes[nid] = state.timelineNodes[nid] || {};
            state.timelineNodes[nid].x = sx;
            state.timelineNodes[nid].y = sy;
            dbg(`group-drag: finalized node ${nid} position at (${sx}, ${sy})`);
          } catch (e) { dbg(`group-drag: error finalizing node ${nid}: ${e?.message}`); }
        }
        _groupDrag.nodeIds = [];
        _groupDrag.startPositions = {};
        try { renderAllLinks(); } catch (e) { dbg(`group-drag: error rendering links after completion: ${e?.message}`); }
        touchSave(); // Save timeline position changes
        dbg(`group-drag: COMPLETED group drag operation`);
        return;
      }
      if (!dragging) return;
      dragging = false;
      try { node.releasePointerCapture(ev.pointerId); } catch (e) {}
      // snap final position to grid and persist
      try {
        const id = node.dataset.nodeId;
        const px = parseFloat(node.style.left || 0);
        const py = parseFloat(node.style.top || 0);
        const sx = snapToGrid(px, TIMELINE.grid);
        const sy = snapToGrid(py, TIMELINE.grid);
        node.style.left = `${sx}px`;
        node.style.top = `${sy}px`;
        state.timelineNodes[id] = state.timelineNodes[id] || {};
        state.timelineNodes[id].x = sx;
        state.timelineNodes[id].y = sy;
        try { renderAllLinks(); } catch (e) { /* best-effort */ }
        touchSave(); // Save timeline position changes
      } catch (e) { /* best-effort */ }
    });

  canvas.appendChild(node);

  // Attach color button/panel to node (after append so absolute positions work)
  node.appendChild(colorBtn);
  node.appendChild(colorPanel);

    // store in-memory (initialize handles list)
    const entryKeyVal = entryKey(entry);
    dbg(`timeline: createTimelineNodeForEntry - storing entryKey=${entryKeyVal} for entry id=${entry?.id} code=${entry?.code} type=${entry?.type}`);
    state.timelineNodes[nodeId] = { entryId: entryKeyVal, x, y, color, handles: [] };
    // create the initial empty handles on both sides so user can connect from either side
    try {
      addHandleToNode(nodeId, false, 'left');
      addHandleToNode(nodeId, false, 'right');
    } catch (e) { dbg('createTimelineNodeForEntry addHandle failed: ' + (e && e.message)); }
    dbg(`timeline: node created id=${nodeId} entry=${entry?.id} entryKey=${entryKeyVal} pos=${x},${y} color=${color} -> debug.log`);
    touchSave(); // Save timeline changes
    // Also immediately save timeline data to ensure persistence
    try { saveToDisk(); } catch (e) { dbg('timeline: immediate save failed: ' + (e?.message || e)); }
    return nodeId;
  }

  // Version of createTimelineNodeForEntry that allows specifying nodeId and color (for loading)
  function createTimelineNodeForEntryWithId(entry, x, y, forcedNodeId, forcedColor, savedHandles) {
    const canvas = ensureTimelineCanvas();
    if (!canvas) return null;
    dbg(`timeline: createTimelineNodeForEntryWithId received entry=${entry?.id} x=${x} y=${y} forcedNodeId=${forcedNodeId} forcedColor=${forcedColor} handles=${savedHandles?.length || 0}`);

    const nodeId = forcedNodeId || `tn-${uid()}`;
    const color = forcedColor || pickColorForEntry(entry);

    const node = document.createElement('div');
    node.className = 'timeline-node';
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.style.background = color;
    node.dataset.nodeId = nodeId;
    node.dataset.entryId = entry.id;

    const label = document.createElement('div');
    label.className = 'node-label';
    label.textContent = entry.title || '(Untitled)';

    const kind = document.createElement('div');
    kind.className = 'node-kind';
    kind.textContent = entry.lore_kind || (entry.type || 'lore');

    const leftWrap = document.createElement('div');
    leftWrap.style.display = 'flex';
    leftWrap.style.flexDirection = 'column';
    leftWrap.appendChild(label);
    leftWrap.appendChild(kind);

    const remove = document.createElement('button');
    remove.className = 'remove-btn';
    remove.title = 'Remove from timeline';
    remove.textContent = '×';
    remove.addEventListener('click', (ev) => {
      ev.stopPropagation();
      removeTimelineNode(nodeId);
    });

    // Color picker control (simplified for loaded nodes)
    const colorBtn = document.createElement('button');
    colorBtn.className = 'color-btn';
    colorBtn.title = 'Change color';
    colorBtn.textContent = '◐';

    const colorPanel = document.createElement('div');
    colorPanel.className = 'color-panel';

    const hueInput = document.createElement('input');
    hueInput.type = 'range';
    hueInput.min = 0; hueInput.max = 360; hueInput.step = 1;

    const swatch = document.createElement('span');
    swatch.className = 'color-swatch';

    colorPanel.appendChild(hueInput);
    colorPanel.appendChild(swatch);

    // Color picker functionality (copied from createTimelineNodeForEntry)
    function hslToRgb(h, s, l) {
      s /= 100; l /= 100;
      const k = n => (n + h / 30) % 12;
      const a = s * Math.min(l, 1 - l);
      const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
      return { r: Math.round(255 * f(0)), g: Math.round(255 * f(8)), b: Math.round(255 * f(4)) };
    }
    function rgbToHex(r,g,b){ return '#'+ [r,g,b].map(x => x.toString(16).padStart(2,'0')).join(''); }
    function hexToRgbObj(hex) { const c = hex.replace('#',''); return { r: parseInt(c.slice(0,2),16), g: parseInt(c.slice(2,4),16), b: parseInt(c.slice(4,6),16) }; }
    function rgbToHsl(r,g,b){ r/=255; g/=255; b/=255; const max=Math.max(r,g,b), min=Math.min(r,g,b); let h=0,s=0,l=(max+min)/2; if(max!==min){ const d=max-min; s = l>0.5? d/(2-max-min) : d/(max+min); switch(max){ case r: h=(g-b)/d + (g<b?6:0); break; case g: h=(b-r)/d + 2; break; case b: h=(r-g)/d + 4; break; } h = Math.round(h*60); } return { h: h, s: Math.round(s*100), l: Math.round(l*100) } }

    let initialHue = 220;
    try {
      const rgb = hexToRgbObj(color);
      const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
      initialHue = Number.isFinite(hsl.h) ? hsl.h : initialHue;
    } catch (e) { /* use default */ }

    hueInput.value = initialHue;
    swatch.style.background = color;

    colorBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const isOpen = colorPanel.style.display === 'block';
      colorPanel.style.display = isOpen ? 'none' : 'block';
      if (!isOpen) hueInput.focus();
    });

    hueInput.addEventListener('input', () => {
      const hue = Number(hueInput.value) || 0;
      const rgb = hslToRgb(hue, 80, 60);
      const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
      swatch.style.background = hex;
      node.style.background = hex;
      if (state.timelineNodes[nodeId]) {
        state.timelineNodes[nodeId].color = hex;
      }
      touchSave();
    });

    hueInput.addEventListener('blur', () => {
      colorPanel.style.display = 'none';
    });

    // Node dragging functionality (copied from createTimelineNodeForEntry)
    let dragging = false;
    node.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      const target = ev.target;
      if (target.classList.contains('remove-btn') || target.classList.contains('color-btn') || 
          target.closest('.color-panel') || target.classList.contains('conn-handle')) return;
      ev.preventDefault();
      try { node.setPointerCapture(ev.pointerId); } catch (e) {}
      dragging = true;
      const rect = canvas.getBoundingClientRect();
      const startX = ev.clientX - rect.left - parseFloat(node.style.left || 0);
      const startY = ev.clientY - rect.top - parseFloat(node.style.top || 0);
      
      const moveHandler = (ev) => {
        if (!dragging) return;
        const rect = canvas.getBoundingClientRect();
        const newX = ev.clientX - rect.left - startX;
        const newY = ev.clientY - rect.top - startY;
        node.style.left = `${newX}px`;
        node.style.top = `${newY}px`;
        try { renderAllLinks(); } catch (e) { /* best-effort */ }
      };
      
      node.addEventListener('pointermove', moveHandler);
      node.addEventListener('pointerup', (ev) => {
        if (!dragging) return;
        dragging = false;
        try { node.releasePointerCapture(ev.pointerId); } catch (e) {}
        node.removeEventListener('pointermove', moveHandler);
        const px = parseFloat(node.style.left || 0);
        const py = parseFloat(node.style.top || 0);
        const sx = snapToGrid(px, TIMELINE.grid);
        const sy = snapToGrid(py, TIMELINE.grid);
        node.style.left = `${sx}px`;
        node.style.top = `${sy}px`;
        state.timelineNodes[nodeId] = state.timelineNodes[nodeId] || {};
        state.timelineNodes[nodeId].x = sx;
        state.timelineNodes[nodeId].y = sy;
        try { renderAllLinks(); } catch (e) { /* best-effort */ }
        touchSave();
      });
    });

    // Add UI elements to node
    node.appendChild(leftWrap);
    node.appendChild(remove);
    canvas.appendChild(node);
    
    // Attach color button/panel to node (after append so absolute positions work)
    node.appendChild(colorBtn);
    node.appendChild(colorPanel);

    // Store in-memory state
    const entryKeyVal = entryKey(entry);
    dbg(`timeline: createTimelineNodeForEntryWithId - storing entryKey=${entryKeyVal} for entry id=${entry?.id} code=${entry?.code} type=${entry?.type}`);
    state.timelineNodes[nodeId] = { entryId: entryKeyVal, x, y, color, handles: [] };
    
    // Restore saved handles or create default ones
    try {
      if (savedHandles && savedHandles.length > 0) {
        // Restore saved handles with exact IDs and states
        for (const handleData of savedHandles) {
          const hid = handleData.id;
          const used = handleData.used;
          const side = handleData.side || 'right';
          
          // Add to state
          state.timelineNodes[nodeId].handles.push({ id: hid, used, side });
          
          // Create DOM element
          const hEl = document.createElement('div');
          hEl.className = 'conn-handle';
          hEl.dataset.handleId = hid;
          hEl.dataset.side = side;
          hEl.classList.add(side);
          if (used) hEl.classList.add('used');
          hEl.title = 'Create link';
          node.appendChild(hEl);
          
          dbg(`timeline: createTimelineNodeForEntryWithId - restored handle ${hid} used=${used} side=${side}`);
        }
        updateHandlesForNode(nodeId);
      } else {
        // Create default handles for new nodes
        addHandleToNode(nodeId, false, 'left');
        addHandleToNode(nodeId, false, 'right');
        dbg(`timeline: createTimelineNodeForEntryWithId - created default handles`);
      }
    } catch (e) { dbg('createTimelineNodeForEntryWithId handle restoration failed: ' + (e && e.message)); }
    
    dbg(`timeline: loaded node created id=${nodeId} entry=${entry?.id} entryKey=${entryKeyVal} pos=${x},${y} color=${color}`);
    touchSave(); // Save timeline changes
    return { nodeId, entryKey: entryKeyVal };
  }

  function snapToGrid(v, grid) { return Math.round(v / grid) * grid; }

  function removeTimelineNode(nodeId) {
    try {
      // First, find and remove all links involving this node using existing removeConnection
      const linksToRemove = [];
      for (const [linkId, linkData] of Object.entries(state.timelineLinks || {})) {
        if (linkData.fromNode === nodeId || linkData.toNode === nodeId) {
          linksToRemove.push(linkId);
          dbg(`timeline: removeTimelineNode - found link to remove: ${linkId} (from=${linkData.fromNode} to=${linkData.toNode})`);
        }
      }
      
      // Use the existing removeConnection function for each link
      for (const linkId of linksToRemove) {
        removeConnection(linkId, true); // skipAutoAddHandles=true since node is being deleted
      }
      
      const canvas = ensureTimelineCanvas();
      const node = canvas.querySelector(`[data-node-id="${nodeId}"]`);
      if (node) node.remove();
      
      // Remove any remaining stale links (belt and suspenders)
      cleanupStaleLinks();
      
      try { renderAllLinks(); } catch (e) { /* best-effort */ }
      delete state.timelineNodes[nodeId];
      dbg(`timeline: node removed id=${nodeId}, cleaned up ${linksToRemove.length} links`);
      touchSave(); // Save timeline changes
    } catch (e) { dbg('removeTimelineNode error: ' + (e && e.message)); }
  }

  // Clean up links that reference non-existent nodes
  function cleanupStaleLinks() {
    const linksToRemove = [];
    for (const [linkId, linkData] of Object.entries(state.timelineLinks || {})) {
      if (!state.timelineNodes[linkData.fromNode] || !state.timelineNodes[linkData.toNode]) {
        linksToRemove.push(linkId);
        dbg(`timeline: cleanupStaleLinks - marking link ${linkId} for removal (missing nodes: from=${linkData.fromNode} to=${linkData.toNode})`);
      }
    }
    
    for (const linkId of linksToRemove) {
      delete state.timelineLinks[linkId];
      dbg(`timeline: cleanupStaleLinks - removed stale link ${linkId}`);
    }
    
    if (linksToRemove.length > 0) {
      dbg(`timeline: cleanupStaleLinks - removed ${linksToRemove.length} stale links`);
    }
  }

  // Handle drop from sidebar entries (they are HTML5 drag sources)
  function installTimelineDropHandlers() {
    const canvas = ensureTimelineCanvas();
    if (!canvas) return;

    // Avoid installing handlers multiple times (initTimelineHandlers is called
    // repeatedly during startup). Mark the canvas once handlers are installed.
    if (canvas.dataset.tlHandlersInstalled) {
      dbg('installTimelineDropHandlers: handlers already installed — skipping');
      return;
    }
    canvas.dataset.tlHandlersInstalled = '1';

    canvas.addEventListener('dragover', (ev) => {
      // allow drop; log for debugging
      dbg(`timeline: dragover at client=${ev.clientX},${ev.clientY}`);
      ev.preventDefault(); // allow drop
    });

    canvas.addEventListener('drop', (ev) => {
      ev.preventDefault();
      try {
        const data = ev.dataTransfer.getData('text/plain');
        dbg(`timeline: drop event data='${String(data)}' at client=${ev.clientX},${ev.clientY}`);
        if (!data) return;
        // data may be entry id
        const entryId = isNaN(Number(data)) ? data : Number(data);
        const entry = findEntryByKey(entryId) || state.entries.find(e => e.id === entryId || String(e.id) === String(entryId));
        dbg(`timeline: resolved entry for drop -> ${entry ? `id=${entry.id} type=${entry.type}` : 'null'}`);
        if (!entry) { dbg('timeline: drop ignored — no entry resolved'); return; }

        // compute canvas-local logical coordinates accounting for transform
        const local = clientToCanvas(ev.clientX, ev.clientY);
        const localX = snapToGrid(local.x, TIMELINE.grid);
        const localY = snapToGrid(local.y, TIMELINE.grid);

        dbg(`timeline: creating node for entry id=${entry.id} code=${entry.code} type=${entry.type} title="${entry.title}" at local=${localX},${localY}`);
        createTimelineNodeForEntry(entry, localX, localY);
      } catch (e) { dbg('timeline drop error: ' + (e && e.message)); }
    });

    // Unified connection interaction system: creation, editing, deletion
    if (!canvas.dataset.tlConnectionHandlersInstalled) {
      canvas.dataset.tlConnectionHandlersInstalled = '1';

      canvas.addEventListener('pointerdown', (ev) => {
        try {
          if (ev.button !== 0) return; // left button only
          
          // Handle SVG path clicks (existing connections)
          if (ev.target && ev.target.tagName === 'path' && ev.target.classList.contains('link')) {
            const linkId = ev.target.dataset.linkId;
            if (!linkId || !state.timelineLinks[linkId]) return;
            
            ev.preventDefault();
            const link = state.timelineLinks[linkId];
            
            // Alt+click to delete connection
            if (ev.altKey && !ev.shiftKey) {
              removeConnection(linkId);
              dbg(`timeline: connection deleted via Alt+click ${linkId}`);
              return;
            }
            
            // Shift+click to edit connection (detach and reconnect)
            if (ev.shiftKey) {
              try { ev.target.setPointerCapture(ev.pointerId); } catch (e) {}
              _editLink.active = true;
              _editLink.linkId = linkId;
              _editLink.fromNode = link.fromNode;
              _editLink.fromHandle = link.fromHandle;
              _editLink.toNode = link.toNode;
              _editLink.toHandle = link.toHandle;
              
              // Remove the existing connection
              removeConnection(linkId);
              
              // Start a new temporary link from the source handle
              startLinkDrag(_editLink.fromNode, _editLink.fromHandle);
              dbg(`timeline: connection edit started ${linkId} - detached and creating temp link`);
              return;
            }
            
            // Normal click - start dragging control points
            try { ev.target.setPointerCapture(ev.pointerId); } catch (e) {}
            _dragLink.active = true;
            _dragLink.linkId = linkId;
            _dragLink.startCanvas = clientToCanvas(ev.clientX, ev.clientY);
            _dragLink.startOffset = Object.assign({}, link.cpOffset || { x: 0, y: 0 });
            dbg(`timeline: link drag start ${linkId}`);
            return;
          }
          
          // Handle connection handle clicks
          if (ev.target && ev.target.classList && ev.target.classList.contains('conn-handle')) {
            const target = ev.target;
            const nodeEl = target.closest('.timeline-node');
            if (!nodeEl) return;
            const nodeId = nodeEl.dataset.nodeId;
            const handleId = target.dataset.handleId;
            if (!nodeId) return;
            
            ev.preventDefault();
            
            // Check if this handle is used (has an existing connection)
            if (target.classList.contains('used')) {
              // USED HANDLE: Find and edit/delete the existing connection
              dbg(`timeline: editing connection on used handle ${handleId}`);
              
              // Find the connection that uses this handle
              let connectionId = null;
              let connection = null;
              for (const [lid, link] of Object.entries(state.timelineLinks)) {
                if (link.fromHandle === handleId || link.toHandle === handleId) {
                  connectionId = lid;
                  connection = link;
                  break;
                }
              }
              
              if (!connection) {
                dbg(`timeline: no connection found for used handle ${handleId}`);
                return;
              }
              
              // Alt+click to delete the connection
              if (ev.altKey) {
                removeConnection(connectionId);
                dbg(`timeline: connection deleted via Alt+click on handle ${connectionId}`);
                return;
              }
              
              // Shift+click or normal click to edit (detach and reconnect)
              _editLink.active = true;
              _editLink.linkId = connectionId;
              _editLink.fromNode = connection.fromNode;
              _editLink.fromHandle = connection.fromHandle;
              _editLink.toNode = connection.toNode;
              _editLink.toHandle = connection.toHandle;
              
              dbg(`timeline: EDIT SETUP - connection ${connectionId} from ${connection.fromNode}:${connection.fromHandle} to ${connection.toNode}:${connection.toHandle}`);
              
              // Determine which end we're editing from
              const isFromHandle = connection.fromHandle === handleId;
              const sourceNode = isFromHandle ? connection.fromNode : connection.toNode;
              const sourceHandleId = isFromHandle ? connection.fromHandle : connection.toHandle;
              
              dbg(`timeline: EDIT SETUP - editing from ${isFromHandle ? 'FROM' : 'TO'} end, sourceNode=${sourceNode}, sourceHandle=${sourceHandleId}`);
              
              // Get the source handle info before removing
              if (!state.timelineNodes[sourceNode]) return;
              const nodeHandles = state.timelineNodes[sourceNode].handles || [];
              const sourceHandleObj = nodeHandles.find(h => h.id === sourceHandleId);
              if (!sourceHandleObj) return;
              const sourceSide = sourceHandleObj.side || 'right';
              
              // Remove the existing connection (skip auto-adding handles since we'll add one manually)
              removeConnection(connectionId, true);
              
              // Add a single new unused handle for the temp link
              const newTempHandleId = addHandleToNode(sourceNode, false, sourceSide);
              dbg(`timeline: EDIT SETUP - created temp handle ${newTempHandleId} on node ${sourceNode} side ${sourceSide}`);
              
              // Start a new temporary link from the new unused handle
              startLinkDrag(sourceNode, newTempHandleId);
              dbg(`timeline: EDIT SETUP - connection edit started ${connectionId} - detached and creating temp link from new handle ${newTempHandleId}`);
              
            } else {
              // UNUSED HANDLE: Create new connection
              startLinkDrag(nodeId, handleId);
              dbg(`timeline: started new connection from unused handle ${handleId}`);
            }
          }
        } catch (e) { dbg('unified connection pointerdown error: ' + (e && e.message)); }
      });
      
      // Global pointermove for both connection creation and editing
      window.addEventListener('pointermove', (ev) => {
        try {
          // Handle temporary link creation/editing
          if (_tempLink.active) {
            ev.preventDefault();
            updateTempLink(ev.clientX, ev.clientY);
            return;
          }
          
          // Handle connection control point dragging
          if (_dragLink.active) {
            const canvasPos = clientToCanvas(ev.clientX, ev.clientY);
            const dx = canvasPos.x - _dragLink.startCanvas.x;
            const dy = canvasPos.y - _dragLink.startCanvas.y;
            const link = state.timelineLinks[_dragLink.linkId];
            if (link) {
              link.cpOffset = {
                x: _dragLink.startOffset.x + dx,
                y: _dragLink.startOffset.y + dy
              };
              renderAllLinks();
            }
          }
        } catch (e) { /* best-effort */ }
      });

      // Global pointerup for all connection interactions
      window.addEventListener('pointerup', (ev) => {
        try {
          // Handle temporary link completion
          if (_tempLink.active) {
            dbg(`timeline: POINTER UP - temp link active, fromNode=${_tempLink.fromNode}, fromHandle=${_tempLink.fromHandle}`);
            dbg(`timeline: POINTER UP - editLink active=${_editLink.active}, linkId=${_editLink.linkId}`);
            
            const el = document.elementFromPoint(ev.clientX, ev.clientY);
            const handle = el && el.closest ? el.closest('.conn-handle') : null;
            const targetNode = handle ? handle.closest('.timeline-node') : null;
            const targetId = targetNode ? targetNode.dataset.nodeId : null;
            const targetHandleId = handle ? handle.dataset.handleId : null;
            
            dbg(`timeline: POINTER UP - target detection: element=${el?.tagName}, handle=${!!handle}, targetNode=${targetId}, targetHandle=${targetHandleId}`);
            
            // Handle connection editing vs deletion
            if (_editLink.active) {
              dbg(`timeline: DECISION - editLink active, checking target validity`);
              dbg(`timeline: DECISION - targetId=${targetId}, targetHandleId=${targetHandleId}, fromNode=${_tempLink.fromNode}`);
              
              if (!targetId || !targetHandleId || targetId === _tempLink.fromNode) {
                // No valid target or same node = DELETE the connection
                dbg(`timeline: DECISION -> DELETE - no valid target or self-connection`);
                
                // Clean up the temporary handle we created
                const sourceNode = _tempLink.fromNode;
                const sourceHandleId = _tempLink.fromHandle;
                
                dbg(`timeline: DELETE CLEANUP - sourceNode=${sourceNode}, sourceHandleId=${sourceHandleId}`);
                
                if (sourceNode && sourceHandleId && state.timelineNodes[sourceNode]) {
                  const handles = state.timelineNodes[sourceNode].handles || [];
                  dbg(`timeline: DELETE CLEANUP - node has ${handles.length} handles: ${handles.map(h => `${h.id}(${h.used?'used':'unused'})`).join(', ')}`);
                  
                  const handleIdx = handles.findIndex(h => h.id === sourceHandleId);
                  dbg(`timeline: DELETE CLEANUP - looking for handle ${sourceHandleId}, found at index ${handleIdx}`);
                  
                  if (handleIdx >= 0) {
                    handles.splice(handleIdx, 1);
                    dbg(`timeline: DELETE CLEANUP - removed temp handle ${sourceHandleId}, remaining: ${handles.map(h => `${h.id}(${h.used?'used':'unused'})`).join(', ')}`);
                    updateHandlesForNode(sourceNode);
                  } else {
                    dbg(`timeline: DELETE CLEANUP - ERROR: temp handle ${sourceHandleId} not found in handles!`);
                  }
                } else {
                  dbg(`timeline: DELETE CLEANUP - ERROR: invalid state sourceNode=${sourceNode} sourceHandleId=${sourceHandleId} nodeExists=${!!state.timelineNodes[sourceNode]}`);
                }
                
                // Reset edit state
                _editLink.active = false;
                _editLink.linkId = null;
                _editLink.fromNode = null;
                _editLink.fromHandle = null;
                _editLink.toNode = null;
                _editLink.toHandle = null;
                
                // Clear temp link state to prevent finishLinkDrag from running
                _tempLink.active = false;
                if (_tempLink.svgPath) {
                  try { _tempLink.svgPath.remove(); } catch (e) {}
                  _tempLink.svgPath = null;
                }
                _tempLink.fromNode = null;
                _tempLink.fromHandle = null;
                
                dbg(`timeline: connection deleted successfully`);
              } else {
                // Valid target = EDIT the connection (reconnect)
                dbg(`timeline: DECISION -> EDIT - reconnecting to new target ${targetId}:${targetHandleId}`);
                // Store edit context for debugging before clearing active flag
                window._editContext = {
                  active: true,
                  sourceNode: _tempLink.fromNode,
                  originalTargetNode: _editLink.toNode,
                  newTargetNode: targetId
                };
                dbg(`timeline: EDIT CONTEXT STORED - source=${_tempLink.fromNode}, originalTarget=${_editLink.toNode}, newTarget=${targetId}`);
                _editLink.active = false; // Let finishLinkDrag handle the reconnection
              }
            }
            
            finishLinkDrag(ev.clientX, ev.clientY, targetId, targetHandleId);
            return;
          }
          
          // Handle connection editing completion
          if (_editLink.active) {
            _editLink.active = false;
            _editLink.linkId = null;
            _editLink.fromNode = null;
            _editLink.fromHandle = null;
            _editLink.toNode = null;
            _editLink.toHandle = null;
            dbg('timeline: connection edit ended');
            return;
          }
          
          // Handle connection drag completion
          if (_dragLink.active) {
            _dragLink.active = false;
            _dragLink.linkId = null;
            _dragLink.startCanvas = null;
            _dragLink.startOffset = null;
            dbg('timeline: connection drag ended');
          }
        } catch (e) { dbg('unified connection pointerup error: ' + (e && e.message)); }
      });
    }
  }

  // Initialize timeline handlers after DOM ready; also attempt immediately and add a short fallback
  function initTimelineHandlers() {
    try { installTimelineDropHandlers(); } catch (e) { dbg('installTimelineDropHandlers failed: ' + (e && e.message)); }
    // Ensure transform initialised
    setTimelineTransform();
    // ensure box-select handlers are installed for the canvas
    try { _installBoxSelectHandlers(ensureTimelineCanvas()); } catch (e) { dbg('installBoxSelectHandlers failed: ' + (e && e.message)); }

    // Keyboard shortcuts for selection
    try {
      document.addEventListener('keydown', (ev) => {
        // Escape clears selection
        if (ev.key === 'Escape') {
          clearTimelineSelection();
        }
        // Ctrl/Cmd + A selects all
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a') {
          ev.preventDefault();
          selectAllTimelineNodes();
        }
      });
    } catch (e) { /* best-effort */ }
    // Install wheel zoom and middle-button pan handlers on the canvas (single install)
    try {
      const canvas = ensureTimelineCanvas();
      if (canvas && !canvas.dataset.tlPanZoomInstalled) {
        canvas.dataset.tlPanZoomInstalled = '1';

        // Wheel: plain wheel -> zoom centered on viewport center; Ctrl+wheel -> zoom at mouse
        canvas.addEventListener('wheel', (ev) => {
          try {
            ev.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            const delta = ev.deltaY;
            const factor = delta < 0 ? 1.12 : 1 / 1.12;
            const cur = state.timelineViewport.scale || 1;
            const target = cur * factor;
            if (ev.ctrlKey || ev.metaKey) {
              setTimelineScale(target, ev.clientX, ev.clientY);
            } else {
              setTimelineScale(target, centerX, centerY);
            }
          } catch (e) { dbg('timeline wheel error: ' + (e && e.message)); }
        }, { passive: false });

        // Middle-button panning (pointer events)
        let panning = false;
        let panStart = { x: 0, y: 0 };
        let panOrig = { tx: 0, ty: 0 };
        canvas.addEventListener('pointerdown', (ev) => {
          try {
            if (ev.button !== 1) return; // only middle button
            ev.preventDefault();
            canvas.setPointerCapture(ev.pointerId);
            panning = true;
            panStart = { x: ev.clientX, y: ev.clientY };
            panOrig = { tx: state.timelineViewport.tx || 0, ty: state.timelineViewport.ty || 0 };
          } catch (e) { /* best-effort */ }
        });
        canvas.addEventListener('pointermove', (ev) => {
          try {
            if (!panning) return;
            ev.preventDefault();
            const dx = ev.clientX - panStart.x;
            const dy = ev.clientY - panStart.y;
            state.timelineViewport.tx = Math.round(panOrig.tx + dx);
            state.timelineViewport.ty = Math.round(panOrig.ty + dy);
            // clamp to container so we can't pan under UI
            clampTimelinePan();
            setTimelineTransform();
          } catch (e) { /* best-effort */ }
        });
        canvas.addEventListener('pointerup', (ev) => {
          try {
            if (!panning) return;
            panning = false;
            try { canvas.releasePointerCapture(ev.pointerId); } catch (__) {}
          } catch (e) { /* best-effort */ }
        });
      }
    } catch (e) { dbg('install pan/zoom handlers failed: ' + (e && e.message)); }
  }

  // Try immediately (if canvas already present)
  initTimelineHandlers();

  // Also bind to DOMContentLoaded in case elements are added later
  document.addEventListener('DOMContentLoaded', initTimelineHandlers);

  // Fallback attempt after a short delay in case of timing issues
  setTimeout(initTimelineHandlers, 500);

  // Top-level document capture handler as a safety net: handle clicks on
  // writing tabs even if other binding steps fail or run too late. This is
  // deliberately installed early and guarded to avoid double-install.
  try {
    if (!state._docTabHandlerInstalled) {
      document.addEventListener('click', (e) => {
        try {
          const btn = e.target && e.target.closest ? e.target.closest('.tabs-writing .tab[data-tab]') : null;
          if (!btn) return;
          const t = btn.dataset.tab;
          dbg(`docTopLevelTabHandler click -> tab=${t}`);
          if (!t) return;
          if (t === state.activeTab) { dbg(`docTopLevelTabHandler -> already active ${t}`); return; }
          // call switchTab if available
          try { if (typeof switchTab === 'function') switchTab(t); else dbg('docTopLevelTabHandler: switchTab not defined yet'); } catch (er) { dbg('docTopLevelTabHandler error: ' + (er && er.message)); }
        } catch (err) { dbg('docTopLevelTabHandler outer error: ' + (err && err.message)); }
      }, true);
      state._docTabHandlerInstalled = true;
      dbg('docTopLevelTabHandler installed');
    }
  } catch (e) { dbg('Failed to install docTopLevelTabHandler: ' + (e && e.message)); }

  // ───────────────── Utilities ─────────────────
  const nowISO = () => new Date().toISOString();
  const uid = () => Math.random().toString(36).slice(2, 10);
  const capFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  const tabTypeMap = { chapters: "chapter", notes: "note", references: "reference" };
  const typeTabMap = { chapter: "chapters", note: "notes", reference: "references", lore: "lore" };

  // Map lore subtabs -> entry types (future entries should use these types)
  const loreTypeMap = { characters: 'character', locations: 'location', timelines: 'timeline', items: 'item' };

  // Map DB rows → renderer entries (read-only)
  function mapDbChapters(rows) {
    // rows: [{ id, code, number, title, status, tags, updated_at }, ...]
    return (rows || []).map((r, idx) => ({
      // use public code as stable id in UI
      id: r.code || `db-ch-${r.id}`,
      type: "chapter",
      title: r.title || `Untitled Chapter ${(r.number ?? idx) + 1}`,
      status: (r.status || "Draft").toLowerCase(),
      tags: Array.isArray(r.tags) ? r.tags : [],
      synopsis: r.summary || "",
      body: r.content || "",
      order_index: Number.isFinite(r.number) ? r.number : idx,
      updated_at: r.updated_at || nowISO(),
      // optional word goal if you add it later in DB:
      word_goal: r.word_goal ?? 0,
    }));
  }

  function timeAgo(iso) {
    if (!iso) return "—";
    const d = Date.now() - new Date(iso).getTime();
    const m = Math.round(d / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h`;
    const days = Math.round(h / 24);
    return `${days}d`;
  }
  function defaultUntitled(type) {
    const count = state.entries.filter(e => e.type === type).length;
  const nextNum = count + 1;
  const label =
    type === "chapter" ? `Untitled Chapter ${nextNum}` :
    type === "note"    ? `Untitled Note ${nextNum}` :
    type === "reference" ? `Untitled Reference ${nextNum}` :
    type === "lore" ? `Untitled Lore ${nextNum}` :
                         `Untitled Entry ${nextNum}`;
  return label;
  }

  function visibleEntries() {
    dbg(`visibleEntries -> activeTab=${state.activeTab}`);
    // Treat timeline as a view of lore entries (sidebar should show lore when timeline active)
    if (state.activeTab === 'lore' || state.activeTab === 'timeline') {
      // Show all unified lore entries
      const list = state.entries
        .filter(e => e.type === 'lore')
        .sort((a,b)=>a.order_index - b.order_index);
      dbg(`visibleEntries -> filtering lore (unified) matched=${list.length}`);
      return list;
    }
    const t = tabTypeMap[state.activeTab];
    const list = state.entries.filter(e => e.type === t).sort((a,b)=>a.order_index - b.order_index);
    dbg(`visibleEntries -> filtering story type=${t} matched=${list.length}`);
    return list;
  }

  function metaText(e) {
    if (e.type === "chapter") {
      const s = e.status ? capFirst(e.status) : "Draft";
      return `${s} • ${timeAgo(e.updated_at)}`;
    }
    return `${timeAgo(e.updated_at)}`;
  }

  function show(n){ n && n.classList.remove("hidden"); }
  function hide(n){ n && n.classList.add("hidden"); }

  // Inject a bit of CSS (drag indicator + danger button)
  (function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .entry { position: relative; display: flex; align-items: center; gap: 8px; }
      .entry .spacer { flex: 1 1 auto; }
      .entry.drag-target-before::before,
      .entry.drag-target-after::after {
        content: "";
        position: absolute;
        left: 8px; right: 8px;
        height: 2px; background: #2563eb;
      }
      .entry.drag-target-before::before { top: -1px; }
      .entry.drag-target-after::after { bottom: -1px; }
      .entry.dragging { opacity: 0.6; }
      .btn.danger { border-color: #ef4444 !important; color: #ef4444; }
      .btn.danger:hover { background:#fef2f2; }

      /* Finder modal */
      #finder {
        position: fixed; inset: 0; z-index: 99997;
        display: none; align-items: flex-start; justify-content: center;
        background: rgba(17,24,39,.55);
      }

      #finder .card {
        margin-top: 10vh;
        width: min(800px, 92vw);
        background: #fff; color: #111827;
        border: 1px solid #e5e7eb; border-radius: 12px;
        box-shadow: 0 24px 80px rgba(0,0,0,.30);
        padding: 12px;
        font-family: Inter, system-ui, sans-serif;
      }

      #finder .row { display: flex; gap: 8px; align-items: center; }
      #finder input[type="text"] {
        flex: 1; padding: 10px 12px; font-size: 14px;
        border: 1px solid #e5e7eb; border-radius: 8px; outline: none;
      }

      #finder .scopes { display:flex; gap:8px; }
      #finder .scope { font-size:12px; color:#6b7280; }
      #finder .list { margin-top: 8px; max-height: 50vh; overflow:auto; border-top:1px solid #f3f4f6; }
      #finder .item {
        padding: 10px 12px; display:flex; justify-content:space-between; align-items:center;
        cursor: pointer;
      }

      #finder .item:hover { background:#f9fafb; }
      #finder .left { display:flex; gap:8px; align-items:center; }
      #finder .badge {
        font-size: 11px; color:#2563eb; border:1px solid #dbeafe; background:#eff6ff;
        padding:2px 6px; border-radius:999px;
      }

      #finder .title { font-weight:600; }
      #finder .meta { font-size:12px; color:#6b7280; }

    `;
    document.head.appendChild(style);
  })();

    // Background host behind the app
  function ensureAppBg() {
    let bg = document.querySelector(".app-bg");
    if (!bg) {
      bg = document.createElement("div");
      bg.className = "app-bg bg-aurora"; // default
      document.body.appendChild(bg);
    }
    return bg;
  }

  // Apply theme + background according to state.uiPrefs (now honors mode)
  function applyThemeAndBackground() {
    const { mode, theme, bg, bgOpacity, bgBlur, editorDim } = state.uiPrefs;

    const host = ensureAppBg();
    const themeClasses = ["theme-slate","theme-light","theme-dark","theme-forest","theme-rose"];
    const bgClasses = ["bg-none","bg-aurora","bg-space","bg-sunset","bg-ocean"];

    // Clear current classes
    document.body.classList.remove(...themeClasses);
    host.classList.remove(...bgClasses);

    if (mode === "background") {
      // Background-driven visuals
      host.classList.add(`bg-${bg || "aurora"}`);
      host.style.setProperty("--bg-blur", `${bgBlur || 0}px`);
      host.style.setProperty("--bg-opacity", `${bgOpacity ?? 0}`);
      // keep body neutral (no theme), or apply a minimal fallback if you prefer
    } else {
      // Theme-driven visuals
      document.body.classList.add(`theme-${theme || "slate"}`);
      // neutralize bg layer
      host.classList.add("bg-none");
      host.style.setProperty("--bg-blur", `0px`);
      host.style.setProperty("--bg-opacity", `0`);
    }

    // dim editor (readability over images)
    const editor = document.querySelector(".editor");
    if (editor) editor.classList.toggle("dimmed", !!editorDim);

      // Hide legacy #bg-select if it exists (we now use a single select)
    const legacyBg = document.getElementById("bg-select");
    if (legacyBg) legacyBg.closest(".settings-section")?.classList.add("hidden");
  }

// ───────────────── UI Prefs ↔ DB (load/save) ─────────────────
let savePrefsTimer = null;

function getCurrentUIPrefs() {
  const { mode, theme, bg, bgOpacity, bgBlur, editorDim } = state.uiPrefs;
  return { mode, theme, bg, bgOpacity, bgBlur, editorDim };
}

async function loadUIPrefs() {
  if (!ipcRenderer) return;
  try {
    const res = await ipcRenderer.invoke("prefs:get");
    if (res?.ok && res.prefs?.ui_prefs) {
      const u = res.prefs.ui_prefs || {};
      state.uiPrefs.mode      = u.mode      ?? state.uiPrefs.mode;
      state.uiPrefs.theme     = u.theme     ?? state.uiPrefs.theme;
      state.uiPrefs.bg        = u.bg        ?? state.uiPrefs.bg;
      state.uiPrefs.bgOpacity = (typeof u.bgOpacity === "number") ? u.bgOpacity : state.uiPrefs.bgOpacity;
      state.uiPrefs.bgBlur    = (typeof u.bgBlur    === "number") ? u.bgBlur    : state.uiPrefs.bgBlur;
      state.uiPrefs.editorDim = !!(u.editorDim ?? state.uiPrefs.editorDim);
      applyThemeAndBackground();
      dbg("prefs:get -> applied ui_prefs from DB");
    } else {
      dbg("prefs:get -> no ui_prefs in DB; using defaults");
    }
  } catch (err) {
    dbg(`prefs:get error: ${err?.message || err}`);
  }
}

function saveUIPrefsDebounced() {
  if (!ipcRenderer) return;
  clearTimeout(savePrefsTimer);
  savePrefsTimer = setTimeout(async () => {
    try {
      await ipcRenderer.invoke("prefs:set", {
        key: "ui_prefs",
        value: getCurrentUIPrefs(),
      });
      dbg("prefs:set -> ui_prefs saved");
    } catch (err) {
      dbg(`prefs:set error: ${err?.message || err}`);
    }
  }, 400);
}


  // ───────────────── Project Picker Overlay ─────────────────
  let picker = null;
  function ensureProjectPicker() {
    if (picker) return picker;

    picker = document.createElement("div");
    picker.id = "project-picker";
    picker.style.cssText = `
      position:fixed; inset:0; background:rgba(17,24,39,.75);
      display:flex; align-items:center; justify-content:center; z-index:99998;
    `;

    const card = document.createElement("div");
    card.style.cssText = `
      width: min(840px, 92vw); max-height: 80vh; overflow:auto;
      background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:16px;
      box-shadow:0 20px 60px rgba(0,0,0,.25); color:#111827; font-family:Inter,system-ui,sans-serif;
    `;

    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <div>
          <div style="font-weight:700; font-size:18px">Select a Project</div>
          <div id="pp-root" style="font-size:12px; color:#6b7280; margin-top:2px;">Loading…</div>
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          <button id="pp-refresh" class="btn">Refresh</button>
          <button id="pp-saveback" class="btn">Save Back</button>
          <button id="pp-close" class="btn">Close</button>
        </div>
      </div>

      <div style="display:flex; gap:16px; flex-wrap:wrap;">
        <div style="flex:1; min-width:380px;">
          <div style="font-weight:600; margin:8px 0;">Existing Projects</div>
          <div id="pp-list" style="display:flex; flex-direction:column; gap:8px;"></div>
        </div>
        <div style="width:320px;">
          <div style="font-weight:600; margin:8px 0;">Create New</div>
          <div class="create-form" style="display:flex; flex-direction:column; gap:8px;">
            <div class="input-wrap" style="position:relative;">
              <input id="pp-newname" placeholder="Project name" 
                     style="width:100%; padding:8px; border:1px solid #e5e7eb; border-radius:8px; background:#fff;"/>
              <div id="pp-error" style="color:#b91c1c; font-size:12px; position:absolute; left:0; top:100%; display:none;"></div>
            </div>
            <div style="display:flex; gap:8px;">
              <button id="pp-create" class="btn primary" style="flex-grow:1;">Create Project</button>
            </div>
            <div style="font-size:12px; color:#6b7280;">
              Projects are stored under your Documents/InkDoodleProjects folder.
            </div>
          </div>
        </div>
      </div>
    `;

    picker.appendChild(card);
    document.body.appendChild(picker);

    const style = document.createElement("style");
    style.textContent = `
      #project-picker .btn { padding:6px 10px; border:1px solid #e5e7eb; border-radius:8px; background:#fff; cursor:pointer; }
      #project-picker .btn:hover { background:#f9fafb; }
      #project-picker .btn.primary { background:#2563eb; color:#fff; border-color:#2563eb; }
      #project-picker .btn.primary:hover { background:#1d4ed8; }
      #project-picker .btn:disabled { opacity:0.5; cursor:not-allowed; }
      .pp-item { border:1px solid #e5e7eb; border-radius:8px; padding:10px; display:flex; justify-content:space-between; align-items:center; }
      .pp-title { font-weight:600; }
      .pp-path { color:#6b7280; font-size:12px; }
      .pp-actions { display:flex; gap:8px; }
      #project-picker .input-wrap { margin-bottom:16px; }
      #project-picker #pp-error { margin-top:4px; min-height:20px; }
      #project-picker input:disabled { background:#f3f4f6; cursor:not-allowed; }
    `;
    document.head.appendChild(style);

      // Helper to show error message
      const showError = (msg) => {
        const error = $("#pp-error");
        if (error) {
          error.textContent = msg;
          error.style.display = msg ? "block" : "none";
        }
      };

      // Helper to reset form state
      const resetForm = () => {
        const input = $("#pp-newname");
        const createBtn = $("#pp-create");
        if (input) {
          input.value = "";
          input.disabled = false;
          input.style.pointerEvents = "auto";
          input.style.background = "#fff";
        }
        if (createBtn) {
          createBtn.disabled = false;
          createBtn.textContent = "Create Project";
        }
        showError("");
      };

      $("#pp-close").addEventListener("click", () => {
        resetForm();
        hideProjectPicker();
      });
      
      $("#pp-refresh").addEventListener("click", () => refreshProjectList());
      
      $("#pp-saveback").addEventListener("click", async () => {
        if (!state.workspacePath || !state.currentProjectDir) return alert("No active project to save back.");
        dbg("Saving project back to original directory...");
        try {
          await saveToWorkspaceAndProject();
          dbg(`Project saved back to: ${state.currentProjectDir}`);
          alert(`Workspace saved back to:\n${state.currentProjectDir}`);
        } catch (e) {
          dbg(`Save back failed: ${e?.message || String(e)}`);
          return alert(`Save Back failed:\n${e?.message || String(e)}`);
        }
      });

      // Enhanced project creation with proper error handling
      $("#pp-create").addEventListener("click", async () => {
        const input = $("#pp-newname");
        const createBtn = $("#pp-create");
        const name = input?.value?.trim() || "";

        if (!name) {
          showError("Please enter a project name.");
          input?.focus();
          return;
        }

        dbg(`Creating new project "${name}"...`);

        // Disable form while creating
        input.disabled = true;
        createBtn.disabled = true;
        createBtn.textContent = "Creating...";
        showError("");

        async function ensureDirectoryExists(dir) {
          if (!fs.existsSync(dir)) {
            try {
              fs.mkdirSync(dir, { recursive: true });
              await new Promise(resolve => setTimeout(resolve, 100)); // Small delay after creation
              if (!fs.existsSync(dir)) {
                throw new Error(`Failed to create directory: ${dir}`);
              }
            } catch (err) {
              throw new Error(`Failed to create directory ${dir}: ${err.message}`);
            }
          }
        }

        // Create initial project data structure
        const initialProjectData = {
          project: {
            name: name,
            title: name,
            code: `PRJ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            saved_at: new Date().toISOString(),
            creator_id: state.authUser?.id || 1
          },
          entries: [],
          ui: {
            activeTab: "chapters",
            selectedId: null,
            counters: { chapter: 1, note: 1, reference: 1 },
            mode: "theme",
            theme: "slate",
            bg: "aurora",
            bgOpacity: 0.2,
            bgBlur: 2,
            editorDim: false
          },
          version: 1
        };

        try {
          // Create the project directory
          const createResult = await ipcRenderer.invoke("project:new", { 
            name,
            initialData: initialProjectData 
          });
          
          if (!createResult?.ok) {
            throw new Error(createResult?.error || 'Failed to create project');
          }

          // Ensure all required directories exist
          if (createResult.projectPath) {
            await ensureDirectoryExists(createResult.projectPath);
            await ensureDirectoryExists(path.join(createResult.projectPath, 'data'));
            await ensureDirectoryExists(path.join(createResult.projectPath, 'chapters'));
            await ensureDirectoryExists(path.join(createResult.projectPath, 'notes'));
            await ensureDirectoryExists(path.join(createResult.projectPath, 'refs'));
            
            // Ensure project.json exists
            const projectFile = path.join(createResult.projectPath, 'data', 'project.json');
            if (!fs.existsSync(projectFile)) {
              fs.writeFileSync(projectFile, JSON.stringify(initialProjectData, null, 2));
              await new Promise(resolve => setTimeout(resolve, 100)); // Small delay after write
            }
          } else {
            throw new Error('No project path returned from creation');
          }

          // Success - reset form
          resetForm();
          dbg(`Created new project "${name}" with structure`);

          // Wait for filesystem to catch up
          await new Promise(resolve => setTimeout(resolve, 1000));

          // Verify project structure
          if (!fs.existsSync(createResult.projectPath)) {
            throw new Error('Project directory was not created');
          }

          const dataDir = path.join(createResult.projectPath, 'data');
          if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
          }

          const projectFile = path.join(dataDir, 'project.json');
          if (!fs.existsSync(projectFile)) {
            fs.writeFileSync(projectFile, JSON.stringify(initialProjectData, null, 2));
          }

          // Create required folders
          ['chapters', 'notes', 'refs'].forEach(dir => {
            const dirPath = path.join(createResult.projectPath, dir);
            if (!fs.existsSync(dirPath)) {
              fs.mkdirSync(dirPath, { recursive: true });
            }
          });
          
          if (!createResult?.ok) {
            throw new Error(createResult?.error || "Failed to create project");
          }

          // Success - reset form
          resetForm();
          dbg(`Created new project "${name}" with structure`);

          // Ensure project directory exists before trying to load
          if (createResult.projectPath) {
            try {
              if (!fs.existsSync(createResult.projectPath)) {
                fs.mkdirSync(createResult.projectPath, { recursive: true });
              }
              const dataDir = path.join(createResult.projectPath, 'data');
              if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
              }
              // Write initial project.json
              fs.writeFileSync(
                path.join(dataDir, 'project.json'),
                JSON.stringify(initialProjectData, null, 2),
                'utf8'
              );
            } catch (err) {
              throw new Error(`Failed to create project directories: ${err.message}`);
            }
          }

          // Immediately try to load the new project
          const loadResult = await ipcRenderer.invoke("project:load", { 
            dir: createResult.projectPath 
          }).catch(e => ({ok: false, error: String(e)}));

          if (!loadResult?.ok) {
            throw new Error(`Project created but failed to load: ${loadResult?.error || "Unknown error"}`);
          }

          // Update application state with the new project
          state.workspacePath = loadResult.activePath;
          state.currentProjectDir = loadResult.currentProjectDir || createResult.projectPath;
          SAVE_FILE = path.join(state.workspacePath, "data", "project.json");

          // Load the project data
          await appLoadFromDisk();
          hideProjectPicker();

          dbg(`Successfully created and loaded new project "${name}"`);
          showError(""); // Clear any errors
        } catch (error) {
          // Log error but allow retry
          dbg(`Project creation/load failed: ${error.message}`);
          alert(`Failed to create/load project:\n${error.message}`);

          // Re-enable the form
          input.disabled = false;
          createBtn.disabled = false;
          createBtn.textContent = "Create Project";
          input.focus();
          
          // Try to refresh list anyway to show any partial success
          try {
            await refreshProjectList();
          } catch (refreshError) {
            dbg(`Warning: Project list refresh failed: ${refreshError.message}`);
          }
        }
      });

      // Add keyboard handling for the input
      $("#pp-newname")?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          $("#pp-create")?.click();
        } else if (e.key === "Escape") {
          e.preventDefault();
          hideProjectPicker();
        }
        showError(""); // Clear error on typing
      });    return picker;
  }

  async function showProjectPicker() {
    ensureProjectPicker();
    // Ensure the picker accepts pointer events and is visible
    picker.style.pointerEvents = "auto";
    picker.style.display = "flex";
    // NOTE: DB->local syncs have been removed. The picker shows local projects only.
    dbg('showProjectPicker: skipping DB->local sync (disabled)');
    
    refreshProjectList();

    // Reset and focus the new-project input
    const inp = document.querySelector("#pp-newname");
    if (inp) {
      inp.value = ""; // Clear any previous value
      inp.disabled = false; // Ensure enabled
      inp.style.pointerEvents = "auto"; // Ensure clickable
      
      // Focus after a short delay to avoid timing issues
      setTimeout(() => {
        try {
          inp.focus();
          if (typeof inp.setSelectionRange === "function") {
            inp.setSelectionRange(0, inp.value?.length || 0);
          }
        } catch (e) { /* ignore focus failures */ }
      }, 50);
    }
  }
  function hideProjectPicker() {
    if (!picker) return;
    
    // Reset all button states
    const buttons = picker.querySelectorAll("button");
    buttons.forEach(btn => {
      btn.disabled = false;
      if (btn.id === "pp-create") btn.textContent = "Create Project";
      else if (btn.id === "pp-refresh") btn.textContent = "Refresh";
      else if (btn.getAttribute("data-act") === "load") btn.textContent = "Load";
    });
    
    // Reset form state
    const input = $("#pp-newname");
    const error = $("#pp-error");
    
    if (input) {
      input.value = "";
      input.disabled = false;
      input.style.pointerEvents = "auto";
      input.style.background = "#fff";
    }
    if (error) {
      error.style.display = "none";
      error.textContent = "";
    }
    
    // Finally hide the picker
    picker.style.display = "none";
    dbg("Project picker closed and reset");
  }

  async function refreshProjectList() {
    const rootEl = $("#pp-root");
    const listEl = $("#pp-list");
    const refreshBtn = $("#pp-refresh");
    let projectResponse = null;
    
    try {
      // Disable refresh button while loading
      if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.textContent = "Loading...";
      }
      
      rootEl.textContent = "Loading…";
      listEl.innerHTML = "";
      dbg("Refreshing project list...");

      projectResponse = await ipcRenderer.invoke("project:list").catch(e=>({ok:false,error:String(e)}));
      if (!projectResponse?.ok) {
        throw new Error(projectResponse?.error || "Failed to list projects");
      }

      rootEl.textContent = projectResponse.root;
      dbg(`Found ${projectResponse.items.length} projects in ${projectResponse.root}`);

      if (!projectResponse.items.length) {
        listEl.innerHTML = `
          <div class="pp-item">
            <div>No projects yet. Create one on the right.</div>
          </div>`;
        return;
      }

      // Render each project in the list
      for (const item of projectResponse.items) {
        // Try to load project.json to get display title
        if (!item || !item.dir) {
          dbg(`Warning: Invalid project item in list: ${JSON.stringify(item)}`);
          continue;
        }
        let displayTitle = item.name;
        try {
          const projectFile = path.join(item.dir, 'data', 'project.json');
          if (fs.existsSync(projectFile)) {
            const data = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
            displayTitle = data.project?.title || data.project?.name || item.name;
          }
        } catch (e) {
          dbg(`Warning: Could not read project title from ${item.dir}: ${e.message}`);
        }

        const row = document.createElement("div");
        row.className = "pp-item";
        row.innerHTML = `
          <div>
            <div class="pp-title">${displayTitle}</div>
            <div class="pp-path">${item.dir}</div>
          </div>
          <div class="pp-actions">
            <button class="btn" data-act="load">Load</button>
            <button class="btn" data-act="delete">Delete</button>
          </div>
        `;

        // Add click handlers
        const loadBtn = row.querySelector('[data-act="load"]');
        const deleteBtn = row.querySelector('[data-act="delete"]');

        loadBtn.addEventListener("click", async () => {
          try {
            loadBtn.disabled = true;
            loadBtn.textContent = "Loading...";
            
            // Verify project data exists and is valid
            const projectFile = path.join(item.dir, 'data', 'project.json');
            if (!fs.existsSync(projectFile)) {
              throw new Error('Project data not found. The project may be corrupted.');
            }

            try {
              // Parse project JSON and tolerate missing/empty fields.
              let projectData = JSON.parse(fs.readFileSync(projectFile, 'utf8'));

              // Ensure minimal shape so downstream code can read safely
              if (!projectData || typeof projectData !== 'object') projectData = {};
              if (!projectData.project || typeof projectData.project !== 'object') projectData.project = {};
              if (!Array.isArray(projectData.entries)) projectData.entries = projectData.entries || [];

              // No migration or strict validation here — the app expects some fields may be empty
              // Use display fallbacks elsewhere (displayTitle already falls back to item.name)
            } catch (parseError) {
              throw new Error(`Could not read project data: ${parseError.message}`);
            }

            // Save current project if needed
            if (state.workspacePath && state.currentProjectDir) {
              dbg(`Saving current project before switch...`);
              
              // First save to workspace
              try {
                saveToDisk();
              } catch (saveError) {
                dbg(`Warning: Failed to save workspace: ${saveError.message}`);
              }
              
              // Then save back to project directory
              const sb = await ipcRenderer.invoke("project:saveBack", { 
                workspacePath: state.workspacePath, 
                projectDir: state.currentProjectDir 
              }).catch(e=>({ok:false,error:String(e)}));
              
              if (!sb?.ok) {
                const continueAnyway = confirm(
                  `Warning: Failed to save current project:\n${sb?.error || 'Unknown error'}\n\nContinue loading new project anyway?`
                );
                if (!continueAnyway) {
                  loadBtn.disabled = false;
                  loadBtn.textContent = "Load";
                  return;
                }
              }
              
              // NOTE: Automatic project->DB upload has been removed. If you
              // need to perform an upload, do so manually via the server
              // tooling you control. We skip calling 'project:sync' here.
            }

            // Load the project
            dbg(`Loading project from ${item.dir}...`);
            const r = await ipcRenderer.invoke("project:load", { dir: item.dir })
              .catch(e=>({ok:false,error:String(e)}));
              
            if (!r?.ok) throw new Error(r?.error || "Unknown error");

            // Update state with new project info
            state.workspacePath = r.activePath;
            state.currentProjectDir = r.currentProjectDir || item.dir;
            SAVE_FILE = path.join(state.workspacePath, "data", "project.json");

            await appLoadFromDisk();
            hideProjectPicker();
            dbg(`Successfully loaded project from ${item.dir}`);
          } catch (error) {
            dbg(`Project load failed: ${error.message}`);
            alert(`Failed to load project:\n${error.message}`);
            loadBtn.disabled = false;
            loadBtn.textContent = "Load";
          }
        });

        deleteBtn.addEventListener("click", async () => {
          if (!confirm(`Delete project "${displayTitle}"?\nThis removes the folder:\n${item.dir}`)) return;
          try {
            deleteBtn.disabled = true;
            deleteBtn.textContent = "Deleting...";
            const r = await ipcRenderer.invoke("project:delete", { dir: item.dir })
              .catch(e=>({ok:false,error:String(e)}));
            if (!r?.ok) throw new Error(r?.error || "Unknown error");
            await refreshProjectList();
          } catch (error) {
            dbg(`Project deletion failed: ${error.message}`);
            alert(`Delete failed:\n${error.message}`);
            deleteBtn.disabled = false;
            deleteBtn.textContent = "Delete";
          }
        });

        listEl.appendChild(row);
      }
    } catch (error) {
      dbg(`Failed to refresh project list: ${error.message}`);
      rootEl.textContent = "Failed to list projects.";
      alert(error.message || "Unknown error occurred while listing projects");
    } finally {
      // Always re-enable refresh button
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = "Refresh";
      }
    }
  }

  // ───────────────── Rendering ─────────────────

  function clearDragClasses() {
    document.querySelectorAll(".entry.drag-target-before, .entry.drag-target-after").forEach(el => {
      el.classList.remove("drag-target-before", "drag-target-after");
    });
    document.querySelectorAll(".entry.dragging").forEach(el => el.classList.remove("dragging"));
  }

  function renderList() {
    const list = visibleEntries();
    if (el.entryList) el.entryList.innerHTML = "";

    // Hide the old empty overlay
    if (el.empty) { el.empty.classList.add("hidden"); el.empty.style.display = "none"; }

    // Update sidebar header to indicate Lore when in lore mode
    try {
      const sidebarTitle = document.querySelector('.sidebar-header h2');
      if (sidebarTitle) sidebarTitle.textContent = (state.activeTab === 'lore') ? 'Lore' : 'Writing';
    } catch (e) { dbg(`renderList: failed to update sidebar header: ${e?.message || e}`); }

  dbg(`renderList — rendering ${list.length} visible entries (activeTab=${state.activeTab} selected=${state.selectedId})`);
  list.forEach((e, idx) => {
    const li = document.createElement("li");
    li.className = "entry" + (entryKey(e) === state.selectedId ? " selected" : "");
    li.dataset.id = e.id;
    li.dataset.type = e.type;
    li.draggable = true;

    // Badge (show lore_kind for lore entries, otherwise show type)
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = e.type === 'lore' ? (e.lore_kind || 'lore') : e.type;

    const t = document.createElement("span");
    t.className = "title";
    t.textContent = e.title || "(Untitled)";

    const m = document.createElement("span");
    m.className = "meta";
    m.textContent = metaText(e);

    const spacer = document.createElement("span"); // keeps delete on far right
    spacer.className = "spacer";

    li.appendChild(badge);
    li.appendChild(t);
    li.appendChild(m);
    li.appendChild(spacer);

      // Click-to-select
      li.addEventListener("click", () => {
        dbg(`renderList: click -> entryKey=${entryKey(e)} id=${e.id} title="${e.title || ''}"`);
        selectEntry(entryKey(e));
      });

      // Drag events
      li.addEventListener("dragstart", (ev) => {
        state.drag.draggingId = e.id;
        li.classList.add("dragging");
        // Use a stable entry key (prefers code when available) so drop resolution
        // can unambiguously find the same entry across types (lore, chapter, etc.).
        try {
          const payload = entryKey(e);
          dbg(`renderList: dragstart payload='${String(payload)}' for id=${e.id} type=${e.type}`);
          ev.dataTransfer.setData("text/plain", payload);
        } catch (ex) {
          // Fallback to numeric id if something unexpected happens
          ev.dataTransfer.setData("text/plain", e.id);
        }
        ev.dataTransfer.effectAllowed = "move";
      });

      li.addEventListener("dragover", (ev) => {
        const dragging = state.entries.find(x => x.id === state.drag.draggingId);
        if (!dragging || dragging.type !== e.type) return;
        ev.preventDefault();
        const rect = li.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        const pos = ev.clientY < mid ? "before" : "after";
        state.drag.overId = e.id;
        state.drag.overPosition = pos;
        li.classList.toggle("drag-target-before", pos === "before");
        li.classList.toggle("drag-target-after", pos === "after");
      });

      li.addEventListener("dragleave", () => {
        li.classList.remove("drag-target-before", "drag-target-after");
      });

      li.addEventListener("drop", (ev) => {
        ev.preventDefault();
        const fromId = state.drag.draggingId;
        const toId = e.id;
        const pos = state.drag.overPosition || "before";
        clearDragClasses();
        if (!fromId || !toId || fromId === toId) { resetDragState(); return; }
        reorderWithinType(fromId, toId, pos);
        resetDragState();
      });

      li.addEventListener("dragend", () => {
        clearDragClasses();
        resetDragState();
      });

      el.entryList.appendChild(li);
    });
      // If there are no visible entries, and we're in Lore mode, show a helpful
      // empty placeholder with a quick +New button for the current lore subtab.
      if (list.length === 0) {
        // No entries visible. Clear selection and editor. Do not render an
        // inline quick-create here — the main +New button is the canonical
        // place to create entries.
        state.selectedId = null;
        clearEditor();
      } else {
        if (!state.selectedId && list.length > 0) {
          state.selectedId = entryKey(list[0]);
          dbg(`renderList — no selection; defaulting to ${state.selectedId}`);
          populateEditor(list[0]);
        }
      }
    updateWordCount();
  }

  function resetDragState() {
    state.drag.draggingId = null;
    state.drag.overId = null;
    state.drag.overPosition = null;
  }

  function reorderWithinType(fromId, toId, pos /* "before"|"after" */) {
    const from = state.entries.find(e => e.id === fromId);
    const to = state.entries.find(e => e.id === toId);
    if (!from || !to || from.type !== to.type) return;

    const type = from.type;
    const arr = state.entries.filter(e => e.type === type).sort((a,b)=>a.order_index - b.order_index);

    const fromIdx = arr.findIndex(e => e.id === fromId);
    const toIdxRaw = arr.findIndex(e => e.id === toId);
    let insertIdx = pos === "before" ? toIdxRaw : toIdxRaw + 1;

    arr.splice(fromIdx, 1);
    if (fromIdx < insertIdx) insertIdx -= 1;
    arr.splice(insertIdx, 0, from);

    arr.forEach((e, i) => e.order_index = i);

    const others = state.entries.filter(e => e.type !== type);
    state.entries = others.concat(arr);

    renderList();
    touchSave(true);
    dbg(`reordered ${type}: ${from.title} -> ${pos} ${to.title}`);
  }

  // ───────────────── Delete ─────────────────
  function confirmAndDelete(id) {
    const entry = state.entries.find(e => e.id === id || e.code === id || entryKey(e) === String(id));
    if (!entry) return;
    const kind = entry.type === "chapter" ? "Chapter" :
                 entry.type === "note" ? "Note" : "Reference";
    const name = entry.title || `(Untitled ${kind})`;
    if (!confirm(`Delete ${kind}:\n"${name}"?\nThis cannot be undone.`)) return;
    // Delete by stable key (prefer code) to avoid numeric id collisions across types
    const key = entryKey(entry);
    deleteEntry(key);
  }

  function deleteEntry(idOrKey) {
    const targetKey = String(idOrKey);
    const entry = state.entries.find(e => entryKey(e) === targetKey);
    if (!entry) return;
    const type = entry.type;
    state.entries = state.entries.filter(e => entryKey(e) !== targetKey);

    // Recalculate numbering counters after deletion
    const types = ["chapter", "note", "reference"];
    types.forEach(t => {
        const count = state.entries.filter(e => e.type === t).length;
        state.counters[t] = count;
    });

    // Renumber order_index for this type
    const sameType = state.entries.filter(e => e.type === type).sort((a,b)=>a.order_index - b.order_index);
    sameType.forEach((e, i) => e.order_index = i);

    // Choose next selection
    let nextId = null;
    const list = visibleEntries();
    if (list.length) {
      // Prefer the item at the deleted item's old order index, else last one
      const at = Math.min(entry.order_index, list.length - 1);
      nextId = list[at]?.id || list[list.length - 1]?.id || null;
    }

    const selectedEntry = findEntryByKey(state.selectedId);
    const nextEntry = nextId ? state.entries.find(e => e.id === nextId) : null;
    if (selectedEntry && selectedEntry.id === id) {
      state.selectedId = nextEntry ? entryKey(nextEntry) : null;
      if (nextEntry) populateEditor(nextEntry); else clearEditor();
    }

    renderList();
    touchSave(true);
    dbg(`deleted ${type}: "${entry.title || "(untitled)"}"`);
  }

  function clearEditor() {
    if (el.titleInput) el.titleInput.value = "";
    if (el.status) el.status.value = "Draft";
    if (el.tags) el.tags.value = "";
    if (el.synopsis) el.synopsis.value = "";
    if (el.body) el.body.value = "";
    if (el.wordTarget) el.wordTarget.value = "";
    if (el.noteCategory) el.noteCategory.value = "Misc";
    if (el.notePin) el.notePin.checked = false;
    if (el.referenceType) el.referenceType.value = "Glossary";
    if (el.sourceLink) el.sourceLink.value = "";

    // word goal UI
    if (el.wordGoal) el.wordGoal.value = "";
    if (el.goalWrap) el.goalWrap.style.display = "none";
    if (el.goalProgress) el.goalProgress.style.display = "none";

    updateWordCount();
  // Clear lore-specific fields (defensive: some elements may not be inputs)
  if (el.loreTitle) { if ('value' in el.loreTitle) el.loreTitle.value = ""; else el.loreTitle.textContent = ""; }
  if (el.loreKind) { if ('value' in el.loreKind) el.loreKind.value = ""; else el.loreKind.textContent = ""; }
  if (el.loreTags) { if ('value' in el.loreTags) el.loreTags.value = ""; else el.loreTags.textContent = ""; }
  if (el.loreSummary) { if ('value' in el.loreSummary) el.loreSummary.value = ""; else el.loreSummary.textContent = ""; }
  if (el.loreBody) { if ('value' in el.loreBody) el.loreBody.value = ""; else el.loreBody.textContent = ""; }
    // Clear custom paired fields
    if (el.entry1name) { if ('value' in el.entry1name) el.entry1name.value = ""; else el.entry1name.textContent = ""; }
    if (el.entry1content) { if ('value' in el.entry1content) el.entry1content.value = ""; else el.entry1content.textContent = ""; }
    if (el.entry2name) { if ('value' in el.entry2name) el.entry2name.value = ""; else el.entry2name.textContent = ""; }
    if (el.entry2content) { if ('value' in el.entry2content) el.entry2content.value = ""; else el.entry2content.textContent = ""; }
    if (el.entry3name) { if ('value' in el.entry3name) el.entry3name.value = ""; else el.entry3name.textContent = ""; }
    if (el.entry3content) { if ('value' in el.entry3content) el.entry3content.value = ""; else el.entry3content.textContent = ""; }
    if (el.entry4name) { if ('value' in el.entry4name) el.entry4name.value = ""; else el.entry4name.textContent = ""; }
    if (el.entry4content) { if ('value' in el.entry4content) el.entry4content.value = ""; else el.entry4content.textContent = ""; }
  }

  function selectEntry(idOrKey) {
    // idOrKey may be a numeric id or a canonical key (code or type:id)
    dbg(`selectEntry -> requested: ${String(idOrKey)}`);
    const entry = findEntryByKey(idOrKey) || state.entries.find(e => e.id === idOrKey);
    if (entry) {
      dbg(`selectEntry -> resolved to entryKey=${entryKey(entry)} id=${entry.id} title="${entry.title || ''}"`);
      state.selectedId = entryKey(entry);
      populateEditor(entry);
    } else {
      dbg(`selectEntry -> no entry resolved for ${String(idOrKey)}; storing raw selectedId`);
      // Fallback: set raw value (may be resolved later)
      state.selectedId = idOrKey;
    }
    renderList();
  }

  function populateEditor(entry) {
    state.projectName = (el.projectName?.textContent || "").trim() || "Untitled Project";
    if (el.titleInput) el.titleInput.value = entry.title || "";

  if (entry.type === "chapter") {
    show(el.statusWrapper); show(el.tagsWrapper); show(el.synopsisLabel); show(el.synopsis);
    hide(el.noteCategoryWrapper); hide(el.notePinWrapper);
    hide(el.referenceTypeWrapper); hide(el.sourceLinkLabel); hide(el.sourceLink);
    if (el.synopsisLabel) el.synopsisLabel.textContent = "Synopsis";
    if (el.status) { el.status.disabled = false; el.status.value = entry.status || "Draft"; }
    if (el.tags) el.tags.value = (entry.tags || []).join(", ");
    if (el.synopsis) el.synopsis.value = entry.synopsis || "";
    try {
      const s = entry.synopsis ?? null;
      const sample = s !== null && s !== undefined ? String(s).slice(0,200) : null;
      dbg(`renderer: populateEditor chapter id=${entry.id ?? 'n/a'} synopsisPresent=${sample!==null} synopsisLen=${s ? String(s).length : 0} sample=${sample||'<null>'}`);
    } catch (e) { /* best-effort */ }
    if (el.body) el.body.value = entry.body || "";

    // word goal UI (chapters only)
    if (el.goalWrap) el.goalWrap.style.display = "";
    if (el.goalProgress) el.goalProgress.style.display = "flex";
    if (el.wordGoal) el.wordGoal.value = entry.word_goal ?? "";
  } else if (entry.type === "note") {
    // hide goal UI for notes
      if (el.goalWrap) el.goalWrap.style.display = "none";
      if (el.goalProgress) el.goalProgress.style.display = "none";
      hide(el.statusWrapper); show(el.tagsWrapper); hide(el.synopsisLabel); hide(el.synopsis);
      show(el.noteCategoryWrapper); show(el.notePinWrapper);
      hide(el.referenceTypeWrapper); hide(el.sourceLinkLabel); hide(el.sourceLink);
      if (el.tags) el.tags.value = (entry.tags || []).join(", ");
      if (el.noteCategory) el.noteCategory.value = entry.category || "Misc";
      if (el.notePin) el.notePin.checked = !!entry.pinned;
      if (el.body) el.body.value = entry.body || "";
  } else if (entry.type === "reference") {
      hide(el.statusWrapper); show(el.tagsWrapper); show(el.synopsisLabel); show(el.synopsis);
      hide(el.wordTargetWrapper);
      show(el.referenceTypeWrapper); show(el.sourceLinkLabel); show(el.sourceLink);
      hide(el.noteCategoryWrapper); hide(el.notePinWrapper);
      if (el.synopsisLabel) el.synopsisLabel.textContent = "Summary";
      if (el.tags) el.tags.value = (entry.tags || []).join(", ");
      if (el.referenceType) el.referenceType.value = entry.reference_type || "Glossary";
      if (el.synopsis) el.synopsis.value = entry.summary || entry.synopsis || "";
      try {
        const s = entry.summary ?? entry.synopsis ?? null;
        const sample = s !== null && s !== undefined ? String(s).slice(0,200) : null;
        dbg(`renderer: populateEditor reference id=${entry.id ?? 'n/a'} summaryPresent=${sample!==null} summaryLen=${s ? String(s).length : 0} sample=${sample||'<null>'}`);
      } catch (e) { /* best-effort */ }
      if (el.sourceLink) el.sourceLink.value = entry.source_link || "";
      if (el.body) el.body.value = entry.body || "";
    }
    else if (entry.type === 'lore') {
      // Unified lore entries: populate the Lore editor fields and hide chapter-only controls
      hide(el.statusWrapper); hide(el.synopsisLabel); hide(el.synopsis);
      hide(el.noteCategoryWrapper); hide(el.notePinWrapper);
      hide(el.referenceTypeWrapper); hide(el.sourceLinkLabel); hide(el.sourceLink);

      // Populate lore-specific editor (in the dedicated lore pane)
  if (el.loreTitle) { if ('value' in el.loreTitle) el.loreTitle.value = entry.title || ''; else el.loreTitle.textContent = entry.title || ''; }
  if (el.loreKind) { try { el.loreKind.classList.remove('hidden'); } catch (e) {} if ('value' in el.loreKind) el.loreKind.value = entry.lore_kind || ''; else el.loreKind.textContent = entry.lore_kind || ''; }
  if (el.loreTags) { if ('value' in el.loreTags) el.loreTags.value = (entry.tags || []).join(', '); else el.loreTags.textContent = (entry.tags || []).join(', '); }
  if (el.loreSummary) { if ('value' in el.loreSummary) el.loreSummary.value = entry.summary || ''; else el.loreSummary.textContent = entry.summary || ''; }
  if (el.loreBody) { if ('value' in el.loreBody) el.loreBody.value = entry.body || ''; else el.loreBody.textContent = entry.body || ''; }

  // Populate custom paired fields if present on the entry
  if (el.entry1name) { if ('value' in el.entry1name) el.entry1name.value = entry.entry1name || ''; else el.entry1name.textContent = entry.entry1name || ''; }
  if (el.entry1content) { if ('value' in el.entry1content) el.entry1content.value = entry.entry1content || ''; else el.entry1content.textContent = entry.entry1content || ''; }
  if (el.entry2name) { if ('value' in el.entry2name) el.entry2name.value = entry.entry2name || ''; else el.entry2name.textContent = entry.entry2name || ''; }
  if (el.entry2content) { if ('value' in el.entry2content) el.entry2content.value = entry.entry2content || ''; else el.entry2content.textContent = entry.entry2content || ''; }
  if (el.entry3name) { if ('value' in el.entry3name) el.entry3name.value = entry.entry3name || ''; else el.entry3name.textContent = entry.entry3name || ''; }
  if (el.entry3content) { if ('value' in el.entry3content) el.entry3content.value = entry.entry3content || ''; else el.entry3content.textContent = entry.entry3content || ''; }
  if (el.entry4name) { if ('value' in el.entry4name) el.entry4name.value = entry.entry4name || ''; else el.entry4name.textContent = entry.entry4name || ''; }
  if (el.entry4content) { if ('value' in el.entry4content) el.entry4content.value = entry.entry4content || ''; else el.entry4content.textContent = entry.entry4content || ''; }

      // Ensure story editor hidden when lore is active (switchTab handles pane visibility)
      if (el.goalWrap) el.goalWrap.style.display = 'none';
      if (el.goalProgress) el.goalProgress.style.display = 'none';
    } else {
      // ensure lore kind input hidden for non-lore entries
      if (el.loreKind) el.loreKind.classList.add('hidden');
    }

    el.saveState && (el.saveState.textContent = "Autosaved");
    updateWordCount();
  }

  // ───────────────── Create ─────────────────
  function createEntry(kind, opts) {
    opts = opts || {};
    const type = kind;
    const order_index = state.entries.filter(e => e.type === type).length;
    
    // Increment counter for this type first
    state.counters[type] = (state.counters[type] || 0) + 1;
    const count = state.counters[type];

    // Determine project id to use as parent in entry codes
    const projectId = Number(state.project?.id || state.project?.project_id) || 0;
    const pad = (n) => String(n).padStart(6, '0');
    const parentPad = String(projectId).padStart(4, '0');
  const typeCode = type === 'chapter' ? 'CHP' : type === 'note' ? 'NT' : type === 'reference' ? 'RF' :
           type === 'lore' ? 'LOR' :
           type === 'character' ? 'CHR' : type === 'location' ? 'LOC' : type === 'timeline' ? 'TML' :
           type === 'item' ? 'ITM' : 'RF';

    // Use numeric id (sequence) and full code matching main process format
    const seq = (() => {
      const sameType = state.entries.filter(e => e.type === type);
      // If any existing entries have numeric id or code with trailing number, try to find max
      let max = 0;
      for (const e of sameType) {
        if (typeof e.id === 'number') max = Math.max(max, e.id);
        else if (e.code && typeof e.code === 'string') {
          const m = e.code.match(/(\d+)$/);
          if (m) max = Math.max(max, parseInt(m[1], 10));
        }
      }
      return max + 1;
    })();

    const entry = {
      id: seq,
      code: `${typeCode}-${parentPad}-${pad(seq)}`,
      project_id: projectId || undefined,
      creator_id: state.authUser?.id || state.project?.creator_id || undefined,
      type,
      title: type === "chapter" ? `Chapter ${seq}` :
        type === "note" ? `Note ${seq}` :
        type === "lore" ? defaultUntitled('lore') :
        `Reference ${seq}`,
      updated_at: nowISO(),
      created_at: nowISO(),
      order_index,
      body: "",
      tags: []
    };
    
    // Add type-specific fields
    if (type === "chapter") {
      entry.status = "Draft";
      entry.synopsis = ""; 
      entry.word_goal = 0;
      // Add any other chapter-specific fields
      dbg(`chapter:create — Creating new chapter "${entry.title}" with ID ${entry.id}`);
    }
    else if (type === "note") {
      entry.category = "Misc";
      entry.pinned = false;
      dbg(`note:create — Creating new note "${entry.title}" with ID ${entry.id}`);
    } else if (type === 'reference') {
      entry.reference_type = "Glossary";
      entry.summary = "";
      entry.source_link = "";
      dbg(`reference:create — Creating new reference "${entry.title}" with ID ${entry.id}`);
    } else if (type === 'lore') {
      // Unified lore entries: freeform subtype stored in `lore_kind`
      entry.lore_kind = opts.lore_kind || '';
      entry.summary = "";
      entry.body = "";
      entry.tags = [];
      // Initialize four custom paired fields (name + content)
      entry.entry1name = '';
      entry.entry1content = '';
      entry.entry2name = '';
      entry.entry2content = '';
      entry.entry3name = '';
      entry.entry3content = '';
      entry.entry4name = '';
      entry.entry4content = '';
      dbg(`lore:create — Creating new lore entry "${entry.title}" with ID ${entry.id}`);
    }

  // Add to state.entries with proper project code if available
  entry.project_code = state.project?.code;
    state.entries.push(entry);
    
    // Switch to correct tab if needed
    const target = typeTabMap[entry.type];
    if (state.activeTab !== target) {
      dbg(`Tab switch needed for new ${entry.type}: ${state.activeTab} -> ${target}`);
      switchTab(target);
    }
    
  // Update state and select the new entry
  state.selectedId = entryKey(entry);
    
    // Normalize order indices after adding the new entry
    normalizeOrderIndexes();
    
    // Update UI
    renderList();
    populateEditor(entry);
    
    // Focus the title input after a short delay to ensure the editor is ready
    setTimeout(() => {
      if (type === 'lore' && el.loreTitle) {
        try { el.loreTitle.focus(); el.loreTitle.select(); } catch (e) {}
      } else if (el.titleInput) {
        try { el.titleInput.focus(); el.titleInput.select(); } catch (e) {}
      }
    }, 50);

    // Save changes - ensure newly created entries are marked dirty immediately
    try {
      // touchSave normally marks dirty and schedules autosave; be explicit here
      state.dirty = true;
      markDirty();
      scheduleAutosave();
    } catch (e) { /* best-effort */ }
    dbg(`created ${type} "${entry.title}" (ID: ${entry.id}) and selected it - pending save`);
  }

  // ───────────────── Tabs ─────────────────
  function switchTab(tabName) {
    dbg(`switchTab -> requested: ${tabName} (current=${state.activeTab})`);
    const prevActive = state.activeTab;
    state.activeTab = tabName;
    // Update main tabs (writing tabs present in DOM)
    document.querySelectorAll('.tabs .tab[data-tab]').forEach(t => {
      const active = t.dataset.tab === tabName;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    // Update top-level tabs visual state (Story / Lore / Timeline)
    try {
      // Compute which top-tab should appear active: 'lore' and 'timeline' map
      // directly; any other story-writing tab maps to 'story'
      const topActive = (tabName === 'lore' || tabName === 'timeline') ? tabName : 'story';
      document.querySelectorAll('.top-tab').forEach(t => {
        const active = t.dataset.tab === topActive;
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    } catch (e) { dbg('switchTab: top-tab visual update failed: ' + (e && e.message)); }

    // If switching to lore or timeline, hide the writing tabs; otherwise show them
    if (tabName === 'lore' || tabName === 'timeline') {
      if (el.tabsWriting) el.tabsWriting.classList.add('hidden');
      if (el.tabsLore) { el.tabsLore.classList.add('hidden'); el.tabsLore.setAttribute('aria-hidden','true'); }
    } else {
      if (el.tabsWriting) el.tabsWriting.classList.remove('hidden');
      if (el.tabsLore) { el.tabsLore.classList.add('hidden'); el.tabsLore.setAttribute('aria-hidden','true'); }
    }

    // Keep editor pane in sync with the selected tab: show Lore editor when
    // the Lore tab is active, otherwise show the main Story editor.
    try {
      // Only toggle editor panes when entering/exiting Lore mode.
      // Avoid calling switchToStory when switching between story tabs
      // (chapters/notes/references) because that can overwrite the
      // requested tab via state.prevActiveTab.
      if (tabName === 'lore') {
        // Save timeline changes if switching away from timeline
        if (prevActive === 'timeline' && state.dirty) {
          dbg('switchTab: saving timeline changes before switching to lore');
          try { saveToDisk(); } catch (e) { dbg('switchTab: timeline save failed: ' + (e?.message || e)); }
        }
        // Preserve the previous active tab so we can restore it later when exiting Lore
        try { state.prevActiveTab = prevActive; } catch (e) {}
        // Ensure timeline is hidden when switching into lore
        try { if (el.timeline) el.timeline.classList.add('hidden'); } catch (e) {}
        switchToLore();
      } else if (tabName === 'timeline') {
        // Preserve previous active tab and show timeline pane
        try { state.prevActiveTab = prevActive; } catch (e) {}
        try {
          const editor = document.querySelector('.editor'); if (editor) editor.classList.add('hidden');
          if (el.loreEditor) el.loreEditor.classList.add('hidden');
          if (el.timeline) el.timeline.classList.remove('hidden');
        } catch (e) { dbg(`switchTab -> show timeline failed: ${e?.message || e}`); }
      } else if (prevActive === 'lore' || prevActive === 'timeline') {
        // We are coming out of Lore or Timeline into a story tab — save timeline changes first
        if (prevActive === 'timeline' && state.dirty) {
          dbg('switchTab: saving timeline changes before leaving timeline tab');
          try { saveToDisk(); } catch (e) { dbg('switchTab: timeline save failed: ' + (e?.message || e)); }
        }
        // restore story UI.
        switchToStory();
      } else {
        // Switching between story tabs only — ensure writing tabs visible
        if (el.tabsWriting) el.tabsWriting.classList.remove('hidden');
        if (el.tabsLore) { el.tabsLore.classList.add('hidden'); el.tabsLore.setAttribute('aria-hidden','true'); }
        // Ensure timeline hidden
        try { if (el.timeline) el.timeline.classList.add('hidden'); } catch (e) {}
      }
    } catch (e) { dbg(`switchTab -> editor sync failed: ${e?.message || e}`); }

  renderList();
  dbg(`switched tab -> ${tabName}; tabsWriting=${!!el.tabsWriting} tabsLore=${!!el.tabsLore}`);
  }

  // Note: per-subtab switching removed — lore is unified.

  // ───────────────── Lore Editor toggles ─────────────────
  function switchToLore() {
    dbg('UI: switching to Lore editor');
    // Remember previous active tab so we can restore it when returning
    try {
      if (state.activeTab !== 'lore') state.prevActiveTab = state.activeTab;
    } catch (e) {}

    const editor = document.querySelector('.editor');
    if (editor) editor.classList.add('hidden');
    if (el.loreEditor) el.loreEditor.classList.remove('hidden');
    // Reflect top-tab active state
    try {
      document.querySelectorAll('.top-tab').forEach(t => {
        const active = t.dataset.tab === 'lore';
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    } catch (e) { dbg('switchToLore: failed to update top-tab visuals: ' + (e && e.message)); }
    // Ensure timeline is hidden when entering lore
    try { if (el.timeline) el.timeline.classList.add('hidden'); } catch (e) {}
    // ensure the sidebar reflects lore subtabs (do not change activeTab here)
    if (el.tabsWriting) el.tabsWriting.classList.add('hidden');
    if (el.tabsLore) { el.tabsLore.classList.remove('hidden'); el.tabsLore.setAttribute('aria-hidden','false'); }

    // put focus into lore textarea
    setTimeout(() => { try { el.loreBody && el.loreBody.focus(); } catch (e) {} }, 40);
    // Refresh sidebar to show lore entries immediately
    try { renderList(); } catch (e) { dbg(`switchToLore renderList failed: ${e?.message || e}`); }
  }

  function switchToStory() {
    dbg('UI: switching back to Story editor');
    // Restore the previous active tab if we saved one, otherwise default to chapters
    const restore = state.prevActiveTab || 'chapters';
    state.activeTab = restore;

    // Update the tab button active states
    document.querySelectorAll('.tabs .tab[data-tab]').forEach(t => {
      const active = t.dataset.tab === state.activeTab;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    // Ensure top-tab visuals reflect Story selected
    try {
      document.querySelectorAll('.top-tab').forEach(t => {
        const active = t.dataset.tab === 'story';
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    } catch (e) { dbg('switchToStory: failed to update top-tab visuals: ' + (e && e.message)); }

    // Hide timeline pane when returning to story editor
    try { if (el.timeline) el.timeline.classList.add('hidden'); } catch (e) {}

    // Swap sidebar groups back to writing tabs
    if (el.tabsWriting) el.tabsWriting.classList.remove('hidden');
    if (el.tabsLore) { el.tabsLore.classList.add('hidden'); el.tabsLore.setAttribute('aria-hidden','true'); }

    // Show main editor and hide lore editor
    const editor = document.querySelector('.editor');
    if (editor) editor.classList.remove('hidden');
    if (el.loreEditor) el.loreEditor.classList.add('hidden');

    // clear the remembered previous tab
    try { state.prevActiveTab = null; } catch (e) {}

    // restore editor focus
    setTimeout(() => { try { el.titleInput && el.titleInput.focus(); } catch (e) {} }, 40);

    // Refresh sidebar immediately and restore sensible selection
    try {
      // Ensure the sidebar list reflects the restored active tab
      renderList();
      const sel = findEntryByKey(state.selectedId) || visibleEntries()[0];
      if (sel) { state.selectedId = entryKey(sel); populateEditor(sel); }
    } catch (e) { dbg(`switchToStory restore failed: ${e?.message || e}`); }
  }

  // ───────────────── Word Count ─────────────────
  function updateWordCount() {
  const cur = findEntryByKey(state.selectedId);
  if (!el.wordCount) return;

  if (!cur) {
    el.wordCount.textContent = "Words: 0";
    if (el.goalWrap) el.goalWrap.style.display = "none";
    if (el.goalProgress) el.goalProgress.style.display = "none";
    return;
  }

  if (cur.type !== "chapter") {
    el.wordCount.textContent = "Words: —";
    if (el.goalWrap) el.goalWrap.style.display = "none";
    if (el.goalProgress) el.goalProgress.style.display = "none";
    return;
  }

  const text = el.body?.value || "";
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  el.wordCount.textContent = `Words: ${words}`;

  // goal/progress (chapters only)
  const goalVal = (el.wordGoal && el.wordGoal.value !== "")
    ? parseInt(el.wordGoal.value, 10)
    : (cur.word_goal || 0);
  const goal = Number.isFinite(goalVal) && goalVal > 0 ? goalVal : 0;

  if (el.goalWrap) el.goalWrap.style.display = "";
  if (el.goalProgress) el.goalProgress.style.display = "flex";

  const pct = goal ? Math.min(100, Math.round((words / goal) * 100)) : 0;
  if (el.goalFill) el.goalFill.style.width = `${pct}%`;
  if (el.goalPct) el.goalPct.textContent = `${pct}%`;
}


  // ───────────────── Save/Load (workspace) ─────────────────
  function parseTags(text) {
    const v = (text || "").trim();
    return v ? v.split(",").map(s => s.trim()).filter(Boolean) : [];
  }
  function stripUndefined(obj) {
    const out = {};
    for (const k in obj) if (obj[k] !== undefined) out[k] = obj[k];
    return out;
  }
  function ensureDir(p) {
    if (!path || !fs) return;
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  function normalizeOrderIndexes() {
    ["chapter","note","reference"].forEach(type => {
      const items = state.entries.filter(e=>e.type===type).sort((a,b)=> (a.order_index ?? 0) - (b.order_index ?? 0));
      items.forEach((e,i)=> e.order_index = i);
    });
  }
  function deriveCountersIfMissing() {
    const next = { chapter: 1, note: 1, reference: 1 };
    for (const e of state.entries) {
      if (e.type === "chapter") {
        const n = parseInt(String(e.title).match(/Untitled Chapter (\d+)/)?.[1] || 0, 10);
        next.chapter = Math.max(next.chapter, n + 1);
      } else if (e.type === "note") {
        const n = parseInt(String(e.title).match(/Untitled Note (\d+)/)?.[1] || 0, 10);
        next.note = Math.max(next.note, n + 1);
      } else if (e.type === "reference") {
        const n = parseInt(String(e.title).match(/Untitled Reference (\d+)/)?.[1] || 0, 10);
        next.reference = Math.max(next.reference, n + 1);
      }
    }
    state.counters = next;
  }

  // Helper to produce a stable key for an entry (prefers code when available,
  // falls back to type:id). This keeps the selection stable when files use
  // either compact numeric ids or canonical codes.
  function entryKey(e) {
    if (!e) return null;
    if (e.code) return String(e.code);
    return `${e.type}:${e.id}`;
  }

  function findEntryByKey(key) {
    if (key === undefined || key === null) return undefined;
    return state.entries.find(e => entryKey(e) === key || e.id === key || String(e.id) === String(key));
  }

  function collectProjectData() {
    // First ensure all entries have required fields
    state.entries = state.entries.map(entry => {
      if (!entry.updated_at) entry.updated_at = nowISO();
      if (!entry.order_index) entry.order_index = 0;
      return entry;
    });

  // Update the currently selected entry
  const cur = findEntryByKey(state.selectedId);
    if (cur) {
      cur.title = el.titleInput?.value || cur.title;
      if (cur.type === "chapter") {
        cur.status = el.status?.value || "Draft";
        cur.tags = parseTags(el.tags?.value);
        cur.synopsis = el.synopsis?.value || "";
        cur.body = el.body?.value || "";
        // persist word goal
        if (el.wordGoal) {
          const g = parseInt(el.wordGoal.value, 10);
          cur.word_goal = Number.isFinite(g) && g > 0 ? g : 0;
        }
      } else if (cur.type === "note") {
        cur.tags = parseTags(el.tags?.value || '');
        cur.category = el.noteCategory?.value?.trim() || "Misc";
        cur.pinned = !!el.notePin?.checked;
        cur.body = el.body?.value || "";
      } else if (cur.type === "reference") {
        cur.tags = parseTags(el.tags?.value);
        cur.reference_type = el.referenceType?.value || "Glossary";
        cur.summary = el.synopsis?.value || "";
        cur.source_link = el.sourceLink?.value || "";
        cur.body = el.body?.value || "";
      }
      else if (cur.type === 'lore') {
        // Read lore-specific editor fields here so collectProjectData()
        // doesn't accidentally overwrite them (story UI uses el.titleInput).
        try {
          cur.title = el.loreTitle?.value || cur.title;
          cur.lore_kind = el.loreKind?.value || cur.lore_kind || '';
          cur.tags = parseTags(el.loreTags?.value || '');
          cur.summary = el.loreSummary?.value || cur.summary || '';
          cur.body = el.loreBody?.value || cur.body || '';
          for (let i = 1; i <= 4; i++) {
            const n = `entry${i}name`;
            const c = `entry${i}content`;
            if (el[n]) cur[n] = el[n].value || cur[n] || '';
            if (el[c]) cur[c] = el[c].value || cur[c] || '';
          }
        } catch (e) { /* best-effort */ }
      }
      cur.updated_at = nowISO();
    }

    // Get project info
    state.projectName = (el.projectName?.textContent || "").trim() || "Untitled Project";

    // No change tracking - just get the current project code
    const projectCode = state.project?.code;

    // Include canonical project metadata (preserve id and creator when present).
    const projMeta = {
      title: state.projectName,
      name: state.projectName,
      code: projectCode, // Preserve project code if it exists
      saved_at: nowISO(),
      updated_at: nowISO()
    };
    if (state.project && state.project.id) projMeta.id = state.project.id;
    if (state.project && state.project.creator_id) projMeta.creator_id = state.project.creator_id;

    return {
      project: projMeta,
      entries: state.entries.map(stripUndefined),
      timeline: state.timeline || {},
      version: 1
    };
  }

  // Track changes for DB sync
  function getOrCreateChanges() {
    // Read current changes from project.json
    if (fs && path && SAVE_FILE) {
      try {
        const dir = path.dirname(SAVE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(SAVE_FILE)) {
          const data = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
          if (data.chapters && data.notes && data.refs) {
            return {
              chapters: data.chapters,
              notes: data.notes,
              refs: data.refs,
              lore: data.lore || { added: [], updated: [], deleted: [] }
            };
          }
        }
      } catch (e) {
        dbg(`Warning: Could not read changes from disk: ${e?.message || e}`);
      }
    }
    // Return empty changes if file doesn't exist or is invalid
    return {
      chapters: { added: [], updated: [], deleted: [] },
      notes: { added: [], updated: [], deleted: [] },
      refs: { added: [], updated: [], deleted: [] },
      lore: { added: [], updated: [], deleted: [] }
    };
  }

  async function saveToDisk(syncToDb = false) {
    if (!fs || !path || !SAVE_FILE) {
      const msg = "Save disabled: no workspace path. Load/create a project first.";
      dbg(msg); alert(msg); return;
    }
    try {
      // Ensure project directory exists
      if (SAVE_FILE) {
        const projectDir = path.dirname(SAVE_FILE);
        if (!fs.existsSync(projectDir)) {
          fs.mkdirSync(projectDir, { recursive: true });
          dbg(`workspace:save — Created project directory: ${projectDir}`);
        }
        
        // Tracking for DB sync has been removed — do not invoke main handlers
        if (syncToDb) {
          dbg('workspace:save — syncToDb requested but uploads are disabled; skipping change-tracking');
        }
      }

      // Initialize project data
      const data = collectProjectData();
      
      // Initialize empty project structure if it doesn't exist
      if (SAVE_FILE && !fs.existsSync(SAVE_FILE)) {
        const projectRootDir = path.dirname(path.dirname(SAVE_FILE)); // Go up two levels from project.json to get root
        const dataDir = path.dirname(SAVE_FILE); // Just the data directory for project.json
        
        // Create data directory for project.json
        if (!fs.existsSync(dataDir)) {
          fs.mkdirSync(dataDir, { recursive: true });
        }
        
        // Create base directories at project root
        ['chapters', 'notes', 'refs', 'lore'].forEach(dir => {
          const fullPath = path.join(projectRootDir, dir);
          if (!fs.existsSync(fullPath)) {
            fs.mkdirSync(fullPath, { recursive: true });
          }
        });
        
        // Initialize empty project.json (do NOT store UI into project.json)
        const initialData = {
          project: {
            title: state.projectName || "Untitled Project",
            name: state.projectName || "Untitled Project",
            created_at: nowISO(),
            updated_at: nowISO(),
            saved_at: nowISO()
          },
          entries: [],
          version: 1
        };
        
        fs.writeFileSync(SAVE_FILE, JSON.stringify(initialData, null, 2), "utf8");
        dbg(`workspace:save — Initialized new project structure at: ${projectDir}`);
      }

      // Update changes tracking for new items
      const changes = getOrCreateChanges();
      
    // Process each type of entry
    state.entries.forEach(entry => {
      const type = entry.type === 'chapter' ? 'chapters' : 
            entry.type === 'note' ? 'notes' : 
            entry.type === 'reference' ? 'refs' :
            (entry.type === 'lore' ? 'lore' : 'refs');
                    
        // Track the project code if it exists
        if (data.project && data.project.code) {
          entry.project_code = data.project.code;
        }
                    
        // If entry has no id/code, it's new
        if (!entry.id && !entry.code) {
          const changeList = changes[type].added;
          if (!changeList.some(e => e.title === entry.title)) {
            changeList.push(entry);
          }
        } 
        // If it has an id/code but was modified, track update
        else if (entry.updated_at > state.lastSavedAt) {
          const changeList = changes[type].updated;
          const idx = changeList.findIndex(e => e.id === entry.id || e.code === entry.code);
          if (idx >= 0) changeList[idx] = entry;
          else changeList.push(entry);
        }
      });

      // Save entries to individual files
      const projectRootDir = path.dirname(path.dirname(SAVE_FILE)); // Go up two levels from project.json to get root
      
    // Handle new and updated entries
    // Track files we write so we can remove orphan files left on disk
    const writtenFilesByType = { chapters: new Set(), notes: new Set(), refs: new Set(), lore: new Set() };
  for (const entry of state.entries) {
    const type = entry.type === 'chapter' ? 'chapters' : 
          entry.type === 'note' ? 'notes' : 
          entry.type === 'reference' ? 'refs' :
          entry.type === 'lore' ? 'lore' : 'refs';
                    
        // Create type directory if it doesn't exist
          const typeDir = path.join(projectRootDir, type);
        if (!fs.existsSync(typeDir)) {
          fs.mkdirSync(typeDir, { recursive: true });
        }
        
        // Save each entry to its own file.
        // Prefer to reuse an existing on-disk file for the same logical entry (match by id or code)
        // so we preserve the project's original filename format (compact or canonical).
        let filename;
        try {
          // If this entry was loaded from a specific filename, prefer reusing it
          if (entry.__filename && fs.existsSync(path.join(typeDir, entry.__filename))) {
            filename = entry.__filename;
            dbg(`workspace:save — reusing original filename ${type}/${filename} for entry id=${entry.id} code=${entry.code}`);
          } else {
          // Look for an existing file in the type directory that matches this entry by id or code
          const candidates = fs.readdirSync(typeDir).filter(f => f.endsWith('.json'));
          let matched = null;
          for (const f of candidates) {
            try {
              const p = path.join(typeDir, f);
              const raw = fs.readFileSync(p, 'utf8');
              const obj = JSON.parse(raw);
              if ((obj && (obj.code && entry.code && obj.code === entry.code)) || (obj && obj.id !== undefined && entry.id !== undefined && Number(obj.id) === Number(entry.id))) {
                matched = f;
                break;
              }
            } catch (e) { /* ignore candidate parse errors */ }
          }

          if (matched) {
            filename = matched;
            dbg(`workspace:save — reusing existing filename ${type}/${filename} for entry id=${entry.id} code=${entry.code}`);
          } else {
            const prefix = entry.type === 'chapter' ? 'CH' : entry.type === 'note' ? 'NT' : entry.type === 'reference' ? 'RF' : entry.type === 'lore' ? 'LOR' : 'RF';
            // Try to extract numeric id from entry.id
            let idNum = null;
            if (typeof entry.id === 'number') idNum = entry.id;
            else if (typeof entry.id === 'string') {
              const m = entry.id.match(/(\d+)/);
              if (m) idNum = parseInt(m[1], 10);
            }
            if (idNum !== null && Number.isFinite(idNum)) filename = `${prefix}${idNum}.json`;
            else if (entry.id !== undefined && entry.id !== null) filename = `${String(entry.id)}.json`;
            else if (entry.code && typeof entry.code === 'string' && entry.code.trim()) filename = `${entry.code}.json`;
            else filename = `${Date.now()}-${Math.random().toString(36).slice(2,8)}.json`;
          }
          }
        } catch (e) {
          // Fallback: prefer canonical code if available
          if (entry.code && typeof entry.code === 'string' && entry.code.trim()) filename = `${entry.code}.json`;
          else filename = `${Date.now()}-${Math.random().toString(36).slice(2,8)}.json`;
        }

  // Remember filename written for orphan-cleanup later
  try { writtenFilesByType[type].add(filename); } catch (e) { /* best-effort */ }

  // Build a sanitized per-item object using an explicit whitelist of allowed keys per type.
        // This prevents any project-level fields (name, saved_at, version, ui, entries, project)
        // from ever being written into individual entry files.
        function buildSanitizedRawForWrite(view) {
          const raw = view.__raw || {};
          const type = view.type || raw.type || 'chapter';
          const allowedByType = {
            // Note: intentionally omit `order_index` from per-item files — it belongs in data/project.json only
            chapter: ['id','code','project_id','creator_id','title','content','body','status','summary','synopsis','tags','created_at','updated_at','word_goal'],
            note: ['id','code','project_id','creator_id','title','content','body','tags','category','pinned','created_at','updated_at'],
            reference: ['id','code','project_id','creator_id','title','content','body','tags','reference_type','summary','source_link','created_at','updated_at'],
            lore: ['id','code','project_id','creator_id','title','content','body','summary','tags','lore_kind','entry1name','entry1content','entry2name','entry2content','entry3name','entry3content','entry4name','entry4content','created_at','updated_at']
          };

          const allow = allowedByType[type] || allowedByType.chapter;
          const out = {};

          // Copy allowed keys from raw when present
          for (const k of allow) {
            if (Object.prototype.hasOwnProperty.call(raw, k)) out[k] = raw[k];
          }

          // Fill sensible defaults / map UI view fields into allowed keys
          if (!out.id && view.id !== undefined) out.id = view.id;
          if (!out.code && view.code !== undefined) out.code = view.code;
          if (!out.title && view.title !== undefined) out.title = view.title;
          // Preserve the original key used by the file for the main text field.
          // Priority: if raw used 'content' keep/update 'content'; else if raw used 'body' keep/update 'body';
          // otherwise choose a sensible default per type (chapters prefer 'content').
          const preferredTextKey = (raw && Object.prototype.hasOwnProperty.call(raw,'content')) ? 'content'
            : (raw && Object.prototype.hasOwnProperty.call(raw,'body')) ? 'body'
            : (type === 'chapter' ? 'content' : 'body');
          if (preferredTextKey === 'content') {
            out.content = (view.body !== undefined) ? view.body : (raw.content !== undefined ? raw.content : (raw.body !== undefined ? raw.body : ''));
          } else {
            out.body = (view.body !== undefined) ? view.body : (raw.body !== undefined ? raw.body : (raw.content !== undefined ? raw.content : ''));
          }
          if (allow.includes('tags')) out.tags = Array.isArray(view.tags) ? view.tags.slice() : (Array.isArray(raw.tags) ? raw.tags.slice() : []);

          // timestamps
          out.updated_at = nowISO();
          if (!out.created_at) out.created_at = view.created_at || raw.created_at || nowISO();

          // type-specific fields mapped from view when present
          if (type === 'chapter') {
            if (view.status !== undefined) out.status = view.status;
            if (view.synopsis !== undefined) {
              if (Object.prototype.hasOwnProperty.call(raw,'synopsis')) out.synopsis = view.synopsis;
              else if (Object.prototype.hasOwnProperty.call(raw,'summary')) out.summary = view.synopsis;
              else out.synopsis = view.synopsis;
            }
            if (view.word_goal !== undefined) out.word_goal = view.word_goal;
          } else if (type === 'note') {
            if (view.category !== undefined) out.category = view.category;
            if (view.pinned !== undefined) out.pinned = !!view.pinned;
          } else if (type === 'reference') {
            if (view.reference_type !== undefined) out.reference_type = view.reference_type;
            if (view.summary !== undefined) out.summary = view.summary;
            if (view.source_link !== undefined) out.source_link = view.source_link;
          }

          // Lore-specific writable fields
          else if (type === 'lore') {
            if (view.lore_kind !== undefined) out.lore_kind = view.lore_kind;
            // map up to four custom paired fields
            for (let i = 1; i <= 4; i++) {
              const n = `entry${i}name`;
              const c = `entry${i}content`;
              if (view[n] !== undefined) out[n] = view[n];
              if (view[c] !== undefined) out[c] = view[c];
            }
          }

          // Do not write order_index into per-item files; project-level ordering belongs in data/project.json
          // Do not write order_index into per-item files; project-level ordering belongs in data/project.json

          // For lore, we need to emit a legacy-shaped object matching the requested format.
          if (type === 'lore') {
            const loreOut = {};
            // Basics and identification (preserve id/code if present)
            if (view.id !== undefined) loreOut.id = view.id;
            else if (raw.id !== undefined) loreOut.id = raw.id;
            if (view.code !== undefined) loreOut.code = view.code;
            else if (raw.code !== undefined) loreOut.code = raw.code;

            // project_id and creator_id: prefer view -> raw -> runtime state
            if (view.project_id !== undefined) loreOut.project_id = view.project_id;
            else if (raw.project_id !== undefined) loreOut.project_id = raw.project_id;
            else if (state && state.project && (state.project.id !== undefined || state.project.project_id !== undefined)) loreOut.project_id = state.project.id || state.project.project_id;

            if (view.creator_id !== undefined) loreOut.creator_id = view.creator_id;
            else if (raw.creator_id !== undefined) loreOut.creator_id = raw.creator_id;
            else if (state && (state.authUser && (state.authUser.id !== undefined || state.authUser.user_id !== undefined))) loreOut.creator_id = state.authUser.id || state.authUser.user_id;

            // Title
            loreOut.title = (view.title !== undefined) ? view.title : (raw.title !== undefined ? raw.title : '');

            // Use 'content' as the main short text field per requested format. Prefer raw.content, then view.body, then raw.body.
            // Prefer the current in-memory view value if present (user edited in UI).
            // Fallback to raw.content or raw.body when view.body is undefined.
            loreOut.content = (view.body !== undefined) ? view.body : ((raw && Object.prototype.hasOwnProperty.call(raw,'content')) ? raw.content : (raw.body !== undefined ? raw.body : ''));

            // summary
            loreOut.summary = (view.summary !== undefined) ? view.summary : (raw.summary !== undefined ? raw.summary : '');

            // tags
            loreOut.tags = Array.isArray(view.tags) ? view.tags.slice() : (Array.isArray(raw.tags) ? raw.tags.slice() : []);

            // lore_type (legacy key name) prefer view.lore_kind -> raw.lore_kind -> raw.lore_type
            loreOut.lore_type = (view.lore_kind !== undefined) ? view.lore_kind : (raw.lore_kind !== undefined ? raw.lore_kind : (raw.lore_type !== undefined ? raw.lore_type : ''));

            // Map paired fields into 'Field N Name' / 'Field N Content'
            for (let i = 1; i <= 4; i++) {
              const nameField = `Field ${i} Name`;
              const contentField = `Field ${i} Content`;
              const vn = `entry${i}name`;
              const vc = `entry${i}content`;
              loreOut[nameField] = (view[vn] !== undefined) ? view[vn] : (raw[vn] !== undefined ? raw[vn] : (raw[nameField] !== undefined ? raw[nameField] : ''));
              loreOut[contentField] = (view[vc] !== undefined) ? view[vc] : (raw[vc] !== undefined ? raw[vc] : (raw[contentField] !== undefined ? raw[contentField] : ''));
            }

            // timestamps
            loreOut.created_at = view.created_at || raw.created_at || nowISO();
            loreOut.updated_at = nowISO();

            // Return the specially-shaped lore object
            return loreOut;
          }

          // Log any dropped keys for debugging (best-effort)
          try {
            const rawKeys = Object.keys(raw || {});
            const dropped = rawKeys.filter(k => !allow.includes(k));
            if (dropped.length) dbg(`workspace:save — dropping disallowed keys from ${type} (id=${out.id}): ${dropped.join(', ')}`);
          } catch (e) {}

          return out;
        }

  const view = entry;
  const rawToWrite = buildSanitizedRawForWrite(view);
        const entryFile = path.join(typeDir, filename);
        fs.writeFileSync(entryFile, JSON.stringify(rawToWrite, null, 2), "utf8");
        // Log exact file written for debugging of save-back behavior
        try { dbg(`workspace:save — wrote ${type}/${filename} (code=${rawToWrite.code ?? 'n/a'} id=${rawToWrite.id ?? 'n/a'})`); } catch (e) { /* best-effort */ }
      }

      // Remove orphan files that are no longer represented in the in-memory state.
      // Only remove .json files inside the per-type folders. This ensures deleted
      // entries are removed from the actual project on save (not at delete-button time).
      try {
        for (const t of ['chapters', 'notes', 'refs', 'lore']) {
          const dir = path.join(projectRootDir, t);
          if (!fs.existsSync(dir)) continue;
          const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
          for (const f of files) {
            if (!writtenFilesByType[t].has(f)) {
              const p = path.join(dir, f);
              try {
                fs.unlinkSync(p);
                dbg(`workspace:save — removed orphan file ${t}/${f}`);
              } catch (err) {
                dbg(`workspace:save — failed to remove orphan file ${t}/${f}: ${err?.message || err}`);
              }
            }
          }
        }
      } catch (e) {
        dbg(`workspace:save — orphan cleanup failed: ${e?.message || e}`);
      }
      
      // Update project.json without the change tracking arrays
      data.entries = state.entries;
      delete data.chapters;
      delete data.notes;
      delete data.refs;

      // Ensure project.json directory exists
      try {
        const pjDir = path.dirname(SAVE_FILE);
        if (!fs.existsSync(pjDir)) fs.mkdirSync(pjDir, { recursive: true });
      } catch (e) { /* best-effort */ }
      
      // Log save operation
      dbg(`workspace:save — Saving ${state.entries.length} total entries to individual files`);
      
      // Merge with any existing project.json to avoid dropping fields (id, creator_id, created_at, etc.)
      try {
        let existing = {};
        if (fs.existsSync(SAVE_FILE)) {
          try { existing = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8')) || {}; } catch (e) { existing = {}; }
        }
        const merged = Object.assign({}, existing);
        // Only persist a minimal, allowed set of project-level keys to match the example format.
        // Do NOT write project-level UI or saved metadata (name, saved_at, version) into project.json.
        const allowedProjectKeys = ['id','code','title','creator_id','created_at','updated_at'];
        merged.project = {};
        for (const k of allowedProjectKeys) {
          if (data.project && data.project[k] !== undefined) merged.project[k] = data.project[k];
          else if (existing.project && existing.project[k] !== undefined) merged.project[k] = existing.project[k];
        }
        // Defensive: remove any stray project-level keys we don't want persisted here
        delete merged.project.name;
        delete merged.project.saved_at;
        delete merged.project.version;
        delete merged.version;

        // Write minimal index-like entries into project.json to match the example project format.
        // We intentionally DO NOT embed per-item full content (content/body/tags/project_id/etc.) here.
        merged.entries = (state.entries || []).map(view => {
          const raw = (view && view.__raw) ? view.__raw : {};
          return {
            id: raw.id !== undefined ? raw.id : view.id,
            code: raw.code !== undefined ? raw.code : view.code,
            type: view.type || raw.type,
            title: raw.title !== undefined ? raw.title : view.title,
            order_index: raw.order_index !== undefined ? raw.order_index : (view.order_index ?? 0),
            updated_at: raw.updated_at || view.updated_at || nowISO()
          };
        });
        fs.writeFileSync(SAVE_FILE, JSON.stringify(merged, null, 2), "utf8");
      } catch (e) {
        // Fallback to writing data directly
        fs.writeFileSync(SAVE_FILE, JSON.stringify(data, null, 2), "utf8");
      }
      
      // Save timeline data
      dbg(`workspace:save — About to call saveTimelineData() with ${Object.keys(state.timelineNodes || {}).length} nodes, ${Object.keys(state.timelineLinks || {}).length} links`);
      saveTimelineData();
      dbg(`workspace:save — saveTimelineData() completed`);
      
      const t = new Date();
      el.lastSaved && (el.lastSaved.textContent = `Last saved • ${t.toLocaleTimeString()}`);
      el.saveState && (el.saveState.textContent = "Saved");
      state.dirty = false;
      state.lastSavedAt = Date.now();
      dbg(`workspace:save — Successfully saved all changes to ${SAVE_FILE}`);
      renderList();
    } catch (err) {
      console.error(err);
      el.saveState && (el.saveState.textContent = "Save error");
      alert(`Save failed:\n${err?.message || err}\nPath: ${SAVE_FILE}`);
    }
  }

  async function appLoadFromDisk() {
    if (!fs || !path || !SAVE_FILE) { 
      dbg("Load skipped: no workspace path"); 
      return; 
    }
    
    try {
      if (!fs.existsSync(SAVE_FILE)) { 
        dbg("No project.json in workspace; starting fresh"); 
        return; 
      }
      
      // Read project.json and entry files
      let data = null;
      try {
        if (!fs.existsSync(SAVE_FILE)) {
          dbg(`workspace:load — Project file does not exist: ${SAVE_FILE}`);
          throw new Error('Project file not found. Please create a new project.');
        }

        const raw = fs.readFileSync(SAVE_FILE, "utf8");
        data = JSON.parse(raw);
        
        // Basic format validation
        if (!data || typeof data !== 'object') {
          throw new Error('Invalid project data format: not a JSON object');
        }
        if (!data.project || typeof data.project !== 'object') {
          throw new Error('Invalid project data format: missing or invalid project info');
        }
        
        // Load entries from individual files
        const projectRootDir = path.dirname(path.dirname(SAVE_FILE)); // Go up two levels from project.json to get root
  const entryTypes = ['chapters', 'notes', 'refs', 'lore'];
  const entries = [];
  // per-type counters for debug reporting
  const loadStats = { chapters: 0, notes: 0, refs: 0, lore: 0 };
        
        for (const type of entryTypes) {
          const typeDir = path.join(projectRootDir, type);
          if (fs.existsSync(typeDir)) {
            const files = fs.readdirSync(typeDir).filter(f => f.endsWith('.json'));
            for (const file of files) {
              try {
                const entryPath = path.join(typeDir, file);
                const raw = JSON.parse(fs.readFileSync(entryPath, 'utf8'));

                // Backwards-compatibility mappings for legacy lore files
                if (type === 'lore' && raw && typeof raw === 'object') {
                  // map common legacy key names to canonical keys
                  if (raw.lore_type && !raw.lore_kind) raw.lore_kind = raw.lore_type;
                  if (raw.content !== undefined && raw.body === undefined) raw.body = raw.content;
                  // Map example field names like "Field 1 Name" / "Field 1 Content"
                  for (let i = 1; i <= 4; i++) {
                    const nameKey = `Field ${i} Name`;
                    const contentKey = `Field ${i} Content`;
                    // Normalize several legacy/key variants into the canonical
                    // `entry${i}name` / `entry${i}content` keys expected by the UI.
                    if (Object.prototype.hasOwnProperty.call(raw, nameKey) && !Object.prototype.hasOwnProperty.call(raw, `entry${i}name`)) {
                      raw[`entry${i}name`] = raw[nameKey];
                    }
                    // Support underscore variant: entry1_name
                    const underscoreName = `entry${i}_name`;
                    if (Object.prototype.hasOwnProperty.call(raw, underscoreName) && !Object.prototype.hasOwnProperty.call(raw, `entry${i}name`)) {
                      raw[`entry${i}name`] = raw[underscoreName];
                    }
                    if (Object.prototype.hasOwnProperty.call(raw, contentKey) && !Object.prototype.hasOwnProperty.call(raw, `entry${i}content`)) {
                      raw[`entry${i}content`] = raw[contentKey];
                    }
                    // Support underscore variant: entry1_content
                    const underscoreContent = `entry${i}_content`;
                    if (Object.prototype.hasOwnProperty.call(raw, underscoreContent) && !Object.prototype.hasOwnProperty.call(raw, `entry${i}content`)) {
                      raw[`entry${i}content`] = raw[underscoreContent];
                    }
                  }
                }

                // Build a lightweight view for UI while preserving the original raw object and filename
                const inferredType = type === 'chapters' ? 'chapter' : type === 'notes' ? 'note' : type === 'refs' ? 'reference' : type === 'lore' ? 'lore' : 'reference';
                const idFromRaw = (raw && raw.id !== undefined) ? (typeof raw.id === 'number' ? raw.id : Number(String(raw.id).match(/(\d+)/)?.[1])) : undefined;
                const codeFromRaw = raw && raw.code ? String(raw.code) : null;

                const view = {
                  // core fields used by the UI
                  id: Number.isFinite(idFromRaw) ? idFromRaw : undefined,
                  code: codeFromRaw || undefined,
                  type: raw.type || inferredType,
                  title: raw.title || raw.name || '',
                  // prefer body, otherwise content
                  body: raw.body !== undefined ? raw.body : (raw.content !== undefined ? raw.content : ''),
                  tags: Array.isArray(raw.tags) ? raw.tags.slice() : [],
                  // preserve timestamps
                  created_at: raw.created_at || raw.createdAt || undefined,
                  updated_at: raw.updated_at || raw.updatedAt || undefined,
                  // keep original raw and location for save-back
                  __raw: raw,
                  __filename: file,
                  __filepath: entryPath,
                };

                // Promote certain lore-specific raw fields into the top-level view
                // so the UI can read them directly (populateEditor expects them).
                try {
                  if (inferredType === 'lore') {
                    // prefer canonical key names with fallbacks
                    view.lore_kind = raw.lore_kind ?? raw.lore_type ?? raw.loreType ?? '';
                    view.summary = raw.summary ?? raw.synopsis ?? '';
                    // map up to four paired fields
                    for (let i = 1; i <= 4; i++) {
                      const n = `entry${i}name`;
                      const c = `entry${i}content`;
                      view[n] = raw[n] !== undefined ? raw[n] : (raw[`Field ${i} Name`] !== undefined ? raw[`Field ${i} Name`] : '');
                      view[c] = raw[c] !== undefined ? raw[c] : (raw[`Field ${i} Content`] !== undefined ? raw[`Field ${i} Content`] : '');
                    }
                  }
                } catch (e) { /* best-effort */ }

                // Promote summary/synopsis from raw into the top-level view so the
                // renderer/editor can read it directly. Preserve raw on __raw.
                try {
                  if (view.type === 'chapter') {
                    // chapters use 'synopsis' in the UI, but some files may use 'summary'
                    view.synopsis = (raw && (raw.synopsis !== undefined ? raw.synopsis : (raw.summary !== undefined ? raw.summary : '')));
                  } else if (view.type === 'reference') {
                    // references use 'summary' in the UI
                    view.summary = (raw && (raw.summary !== undefined ? raw.summary : (raw.synopsis !== undefined ? raw.synopsis : '')));
                  } else {
                    // notes generally do not use summary/synopsis in the editor, but promote if present
                    view.synopsis = (raw && (raw.synopsis !== undefined ? raw.synopsis : (raw.summary !== undefined ? raw.summary : undefined))); 
                  }
                } catch (e) { /* best-effort */ }

                entries.push(view);
                loadStats[type] = (loadStats[type] || 0) + 1;
                dbg(`workspace:load — read ${type}/${file} (id=${view.id ?? 'n/a'} code=${view.code ?? 'n/a'})`);
                // Debug: report whether a summary/synopsis was present in the raw file
                try {
                  const rawSummaryVal = (raw && (raw.summary !== undefined ? raw.summary : (raw.synopsis !== undefined ? raw.synopsis : null)));
                  const rawSummarySample = rawSummaryVal !== null && rawSummaryVal !== undefined ? String(rawSummaryVal).slice(0,200) : null;
                  const viewSummaryVal = (view && (view.summary !== undefined ? view.summary : (view.synopsis !== undefined ? view.synopsis : null)));
                  const viewSummarySample = viewSummaryVal !== null && viewSummaryVal !== undefined ? String(viewSummaryVal).slice(0,200) : null;
                  dbg(`workspace:load — summaryCheck ${type}/${file} rawPresent=${rawSummarySample!==null} viewPresent=${viewSummarySample!==null} rawSample=${rawSummarySample||'<null>'} viewSample=${viewSummarySample||'<null>'}`);
                } catch (e) { /* best-effort debug */ }
              } catch (entryError) {
                dbg(`Warning: Failed to load entry file ${file}: ${entryError.message}`);
              }
            }
          }
        }

        // Prefer canonical entries (those with full codes like CHP-.../NT-.../RF-...).
        // If only a compact filename exists (CH1.json etc.), promote it to the canonical format on disk
        // so loader/saver remain consistent.
        const projectId = (data.project && (data.project.id || data.project.project_id)) ? Number(data.project.id || data.project.project_id) : 0;
        const pad = (n) => String(n).padStart(6, '0');
        const parentPad = String(projectId).padStart(4, '0');
        const canonicalMap = new Map();

        for (const item of entries) {
          // item is our view object; keep raw object on __raw, and original filename on __filename
          const view = item;
          const raw = view.__raw || {};
          let code = raw.code || view.code || undefined;

          // If entry has no code in raw, try to infer from filename (compact form CH1/NT1/RF1)
          if (!code && view.__filename) {
            const m = view.__filename.match(/^(CH|NT|RF|LOR)(\d+)\.json$/i);
            if (m) {
              const prefix = m[1].toUpperCase();
              const n = parseInt(m[2], 10);
              if (prefix === 'CH') code = `CHP-${parentPad}-${pad(n)}`;
              else if (prefix === 'NT') code = `NT-${parentPad}-${pad(n)}`;
              else if (prefix === 'RF') code = `RF-${parentPad}-${pad(n)}`;
              else if (prefix === 'LOR') code = `LOR-${parentPad}-${pad(n)}`;
            }
          }

          // If we still don't have a code but view.id is numeric, synthesize a code for UI only
          if (!code && typeof view.id === 'number') {
            if (view.type === 'chapter') code = `CHP-${parentPad}-${pad(view.id)}`;
            else if (view.type === 'note') code = `NT-${parentPad}-${pad(view.id)}`;
            else if (view.type === 'reference') code = `RF-${parentPad}-${pad(view.id)}`;
            else if (view.type === 'lore') code = `LOR-${parentPad}-${pad(view.id)}`;
          }

          // Use a logical key based on type+id (prefer id). This keeps entries identified by their on-disk id.
          const logicalId = (typeof view.id === 'number') ? String(view.id) : (view.code || view.title || Math.random());
          const key = `${view.type}:${logicalId}`;

          if (!canonicalMap.has(key)) {
            // attach the resolved code to the view (in-memory only) but do not modify raw on disk
            if (code) view.code = code;
            canonicalMap.set(key, view);
          } else {
            // Merge fields into existing view (prefer earlier file as authoritative on-disk)
            const existing = canonicalMap.get(key);
            // merge raw fields where missing in existing.__raw
            for (const k of Object.keys(raw)) {
              if (existing.__raw && (existing.__raw[k] === undefined || existing.__raw[k] === null || existing.__raw[k] === "")) existing.__raw[k] = raw[k];
            }
            // merge view-level fields conservatively
            for (const k of ['title','body','tags','created_at','updated_at']) {
              if ((existing[k] === undefined || existing[k] === null || existing[k] === '') && (view[k] !== undefined)) existing[k] = view[k];
            }
            dbg(`workspace:load — found duplicate logical entry ${key}; merged in-memory`);
          }
        }

        data.entries = Array.from(canonicalMap.values());
        // Sanitize any entries that may have been stored verbatim inside project.json
        // (some older projects included full per-item objects there). We must
        // ensure per-item raw objects do not contain project-level metadata.
        function sanitizeRawForType(obj, type) {
          const allowed = {
            chapter: ['id','code','project_id','creator_id','title','content','body','status','summary','synopsis','tags','created_at','updated_at','word_goal','order_index'],
            note: ['id','code','project_id','creator_id','title','content','body','tags','category','pinned','created_at','updated_at','order_index'],
            reference: ['id','code','project_id','creator_id','title','content','body','tags','reference_type','summary','source_link','created_at','updated_at','order_index'],
            lore: ['id','code','project_id','creator_id','title','content','body','summary','tags','lore_kind','entry1name','entry1content','entry2name','entry2content','entry3name','entry3content','entry4name','entry4content','created_at','updated_at','order_index']
          };
          const allow = allowed[type] || [];
          const out = {};
          if (!obj || typeof obj !== 'object') return out;
          for (const k of allow) {
            if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
          }
          return out;
        }
        for (const ent of data.entries) {
          try {
            const typ = ent.type || (ent.__raw && ent.__raw.type) || (ent.code && (String(ent.code).startsWith('CHP') ? 'chapter' : String(ent.code).startsWith('NT') ? 'note' : String(ent.code).startsWith('RF') ? 'reference' : String(ent.code).startsWith('LOR') ? 'lore' : null));
            if (ent.__raw && typeof ent.__raw === 'object') {
              ent.__raw = sanitizeRawForType(ent.__raw, typ);
            } else {
              // If there was no __raw, build one from the entry values conservatively
              ent.__raw = sanitizeRawForType(ent, typ);
            }
            // Ensure we don't carry project-level keys accidentally
            delete ent.__raw.name;
            delete ent.__raw.saved_at;
            delete ent.__raw.version;
            delete ent.__raw.ui;
            delete ent.__raw.entries;
            delete ent.__raw.project;
          } catch (e) { /* best-effort */ }
        }
  dbg(`workspace:load — entries loaded: chapters=${loadStats.chapters}, notes=${loadStats.notes}, refs=${loadStats.refs}, lore=${loadStats.lore}; canonical entries=${data.entries.length}`);

        // NOTE: do not normalize or rewrite entry structure here; keep original per-file JSON shapes authoritative.

  // Preserve project object in runtime state for code/id generation
  state.project = data.project || {};
        
        // Ensure minimal project fields exist; don't treat missing optional fields as fatal
        data.project.title = data.project.title || data.project.name || path.basename(projectRootDir) || "Untitled Project";
        data.project.name = data.project.name || data.project.title;
        data.project.saved_at = data.project.saved_at || data.project.created_at || new Date().toISOString();
        data.project.updated_at = data.project.updated_at || data.project.saved_at;
      } catch (parseError) {
        dbg(`Error parsing project data: ${parseError.message}`);
        throw new Error('Project data is corrupted or in invalid format');
      }

      state.projectName = data?.project?.name || "Untitled Project";
      if (el.projectName) el.projectName.textContent = state.projectName;

      state.entries = Array.isArray(data?.entries) ? data.entries : [];
      normalizeOrderIndexes();

      const ui = data?.ui || {};
  state.activeTab = ui.activeTab || "chapters";
  state.selectedId = ui.selectedId || (visibleEntries()[0] ? entryKey(visibleEntries()[0]) : null);
      state.counters = ui.counters || state.counters;
      if (!ui.counters) deriveCountersIfMissing();

     // restore UI prefs with defaults
      state.uiPrefs.mode = ui.mode || state.uiPrefs.mode;
      state.uiPrefs.theme = ui.theme || state.uiPrefs.theme;
      state.uiPrefs.bg = ui.bg || state.uiPrefs.bg;
      state.uiPrefs.bgOpacity = (typeof ui.bgOpacity === "number") ? ui.bgOpacity : state.uiPrefs.bgOpacity;
      state.uiPrefs.bgBlur = (typeof ui.bgBlur === "number") ? ui.bgBlur : state.uiPrefs.bgBlur;
      state.uiPrefs.editorDim = !!(ui.editorDim ?? state.uiPrefs.editorDim);
      applyThemeAndBackground();

      el.tabs?.forEach(t => {
        const active = t.dataset.tab === state.activeTab;
        t.classList.toggle("active", active);
        t.setAttribute("aria-selected", active ? "true" : "false");
      });

  const sel = findEntryByKey(state.selectedId) || visibleEntries()[0];
  if (sel) { state.selectedId = entryKey(sel); populateEditor(sel); }

      renderList();
      
      // Load timeline data
      loadTimelineData();
      
      // Initialize timeline metadata if it doesn't exist
      if (!state.timeline) {
        state.timeline = {};
      }
      if (!state.timeline.id || !state.timeline.code) {
        const projectId = state.project?.id || 1;
        if (!state.timeline.id) {
          const projectIdStr = String(projectId).padStart(4, '0');
          const entryNumber = '000001';
          state.timeline.id = `TMLPRJ-${projectIdStr}-${entryNumber}`;
        }
        if (!state.timeline.code) {
          state.timeline.code = `TMLPRJ-${String(projectId).padStart(4, '0')}-000001`;
        }
        if (!state.timeline.title) {
          state.timeline.title = `${state.projectName || 'Project'} Timeline`;
        }
        if (!state.timeline.description) {
          state.timeline.description = 'Project timeline visualization';
        }
      }
      
      state.dirty = false;
      state.lastSavedAt = Date.now();
      dbg(`Loaded workspace file: ${SAVE_FILE}`);
    } catch (e) {
      console.error(e);
      alert(`Failed to load workspace project:\n${e?.message || e}`);
    }
  }

  // ───────────────── Autosave engine ─────────────────
  function markDirty() {
    state.dirty = true;
    el.saveState && (el.saveState.textContent = "Unsaved (autosave) …");
  }
  function scheduleAutosave() {
    clearTimeout(autosaveDebounce);
    autosaveDebounce = setTimeout(() => {
      if (state.dirty) saveToDisk();
    }, AUTOSAVE_IDLE_MS);
  }
  function startFailsafeTimer() {
    clearInterval(failsafeTimer);
    failsafeTimer = setInterval(() => {
      if (state.dirty && Date.now() - state.lastSavedAt > AUTOSAVE_FAILSAFE_MS) {
        saveToDisk();
      }
    }, AUTOSAVE_FAILSAFE_MS / 2);
  }
  // Save to both workspace and project directory
  async function saveToWorkspaceAndProject() {
    // Always perform Save Back when requested — do not gate on state.dirty.
    // This ensures an explicit Save Back always writes workspace files and
    // copies them back to the project directory even if the autosave
    // dirty tracking is out-of-sync.
    dbg(`workspace:save — Save Back requested (forcing save regardless of dirty flag)`);
    try {
      // Ensure UI values are flushed into state and write to disk
      await saveToDisk(); // Ensure changes are written to disk first
      dbg(`db:sync — Starting sync of workspace changes to DB (if enabled)`);
      const changes = getOrCreateChanges();
      
      // Log what we're about to sync
      const totalChanges = (changes.chapters.added.length + changes.chapters.updated.length) +
                         (changes.notes.added.length + changes.notes.updated.length) +
                         (changes.refs.added.length + changes.refs.updated.length);
      
      dbg(`db:sync — Found ${totalChanges} total changes to sync:`);
      dbg(`db:sync — Chapters: ${changes.chapters.added.length} new, ${changes.chapters.updated.length} updates`);
      dbg(`db:sync — Notes: ${changes.notes.added.length} new, ${changes.notes.updated.length} updates`);
      dbg(`db:sync — References: ${changes.refs.added.length} new, ${changes.refs.updated.length} updates`);
      dbg("Saving to workspace...");
      saveToDisk(); // Save to workspace first
      
      if (!SAVE_FILE) {
        dbg("No workspace file to save back to project");
        return;
      }
      
      dbg("Saving workspace back to project directory...");
      // Use the same IPC channel and parameters as other save-back callers
      const r = await ipcRenderer.invoke("project:saveBack", {
        workspacePath: state.workspacePath,
        projectDir: state.currentProjectDir
      }).catch(e => ({ ok: false, error: String(e) }));

      if (!r?.ok) {
        throw new Error(r?.error || "Failed to save back to project");
      }

      dbg("Successfully saved workspace back to project directory");
    } catch (err) {
      console.error(err);
      dbg(`Error saving to project: ${err.message}`);
      throw err;
    }
  }

  function touchSave() {
    markDirty();
    dbg(`workspace:autosave — Changes detected, scheduling save`);
    scheduleAutosave();
    clearTimeout(_fakeAutosaveUI);
    _fakeAutosaveUI = setTimeout(() => {
      const changes = getOrCreateChanges();
      const totalChanges = 
        changes.chapters.added.length + changes.chapters.updated.length +
        changes.notes.added.length + changes.notes.updated.length +
        changes.refs.added.length + changes.refs.updated.length;
      dbg(`workspace:autosave — Pending changes: ${totalChanges} total`);
      // Continue with UI update
      el.saveState && (el.saveState.textContent = state.dirty ? "Unsaved (autosave) …" : "Autosaved");
    }, 800);
  }
  let _fakeAutosaveUI = null;

  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && state.dirty) saveToDisk();
  });
  window.addEventListener("beforeunload", () => {
  if (state.dirty) try { saveToDisk(); } catch {}
});
// Pipe runtime errors into debug.log as well
window.addEventListener("error", (e) => _dbgAppendToFile(`[${new Date().toISOString()}] window.error: ${e.message}`));
window.addEventListener("unhandledrejection", (e) => _dbgAppendToFile(`[${new Date().toISOString()}] unhandledrejection: ${String(e.reason)}`));


  // ───────────────── Wiring ─────────────────
  el.projectName?.addEventListener("input", () => {
    state.projectName = (el.projectName.textContent || "").trim() || "Untitled Project";
    touchSave();
  });
  el.titleInput?.addEventListener("input", () => {
    const e = findEntryByKey(state.selectedId);
    if (!e) return;
    e.title = el.titleInput.value;
    renderList();
    touchSave();
  });
  el.status?.addEventListener("change", () => {
    const e = findEntryByKey(state.selectedId);
    if (!e || e.type !== "chapter") return;
    e.status = el.status.value;
    renderList();
    touchSave();
  });
  el.tags?.addEventListener("blur", () => {
    const e = findEntryByKey(state.selectedId);
    if (!e) return;
    e.tags = parseTags(el.tags.value);
    touchSave();
  });
  el.synopsis?.addEventListener("input", () => {
    const e = findEntryByKey(state.selectedId);
    if (!e) return;
    if (e.type === "chapter") e.synopsis = el.synopsis.value;
    else if (e.type === "reference") e.summary = el.synopsis.value;
    touchSave();
  });
  el.body?.addEventListener("input", () => {
    const e = findEntryByKey(state.selectedId);
    if (!e) return;
    e.body = el.body.value;
    updateWordCount();
    touchSave();
  });
  // Chapter-only: word target
  el.wordTarget?.addEventListener("input", () => {
    const e = findEntryByKey(state.selectedId);
    if (!e || e.type !== "chapter") return;
    e.word_target = parseInt(el.wordTarget.value || 0, 10) || 0;
    updateWordCount();
    touchSave();
  });
  // Notes-only
  el.noteCategory?.addEventListener("change", () => {
    const e = findEntryByKey(state.selectedId);
    if (!e || e.type !== "note") return;
    e.category = el.noteCategory.value;
    touchSave();
  });
  el.notePin?.addEventListener("change", () => {
    const e = findEntryByKey(state.selectedId);
    if (!e || e.type !== "note") return;
    e.pinned = !!el.notePin.checked;
    touchSave();
  });
  // References-only
  el.referenceType?.addEventListener("change", () => {
  const e = findEntryByKey(state.selectedId);
  if (!e || e.type !== "reference") return;
  e.reference_type = el.referenceType.value;
  touchSave();
});

// Word goal (chapters only)
el.wordGoal?.addEventListener("input", () => {
  const e = findEntryByKey(state.selectedId);
  if (!e || e.type !== "chapter") return;
  const g = parseInt(el.wordGoal.value, 10);
  e.word_goal = Number.isFinite(g) && g > 0 ? g : 0;
  updateWordCount();  // refresh progress bar
  touchSave();
});

  el.sourceLink?.addEventListener("input", () => {
    const e = findEntryByKey(state.selectedId);
    if (!e || e.type !== "reference") return;
    e.source_link = el.sourceLink.value;
    touchSave();
  });

  // Sidebar
  el.newBtn?.addEventListener("click", () => {
    let kind = null;
    let opts = {};
    if (state.activeTab === 'lore') {
      // Create a unified lore entry; no prefilled category
      kind = 'lore';
    } else {
      kind = tabTypeMap[state.activeTab];
    }
    if (!kind) kind = 'chapter';
    createEntry(kind, opts);
  });

  // Hidden empty-state quick create (overlay unused)
  el.quickCreate?.forEach(btn => {
    btn.addEventListener("click", () => {
      const kind = btn.dataset.new;
      createEntry(kind);
    });
  });

  // Lore kind input: update current entry's lore_kind when edited
  el.loreKind?.addEventListener('input', (ev) => {
    try {
      const cur = findEntryByKey(state.selectedId);
      if (!cur || cur.type !== 'lore') return;
      cur.lore_kind = (el.loreKind.value || '').trim();
      touchSave();
      renderList();
    } catch (e) { dbg('loreKind input error: ' + (e && e.message)); }
  });

  // Lore title
  el.loreTitle?.addEventListener('input', () => {
    const e = findEntryByKey(state.selectedId);
    if (!e || e.type !== 'lore') return;
    e.title = el.loreTitle.value;
    renderList();
    touchSave();
  });

  // Lore tags (commit on blur)
  el.loreTags?.addEventListener('blur', () => {
    const e = findEntryByKey(state.selectedId);
    if (!e || e.type !== 'lore') return;
    e.tags = parseTags(el.loreTags.value);
    touchSave();
  });

  // Lore summary
  el.loreSummary?.addEventListener('input', () => {
    const e = findEntryByKey(state.selectedId);
    if (!e || e.type !== 'lore') return;
    e.summary = el.loreSummary.value;
    touchSave();
  });

  // Lore body
  el.loreBody?.addEventListener('input', () => {
    const e = findEntryByKey(state.selectedId);
    if (!e || e.type !== 'lore') return;
    e.body = el.loreBody.value;
    updateWordCount();
    touchSave();
  });

  // Custom paired fields: entry1..entry4 name + content
  el.entry1name?.addEventListener('input', () => {
    const e = findEntryByKey(state.selectedId);
    if (!e || e.type !== 'lore') return;
    e.entry1name = el.entry1name.value;
    touchSave();
  });
  el.entry1content?.addEventListener('input', () => {
    const e = findEntryByKey(state.selectedId);
    if (!e || e.type !== 'lore') return;
    e.entry1content = el.entry1content.value;
    touchSave();
  });

  el.entry2name?.addEventListener('input', () => {
    const e = findEntryByKey(state.selectedId);
    if (!e || e.type !== 'lore') return;
    e.entry2name = el.entry2name.value;
    touchSave();
  });
  el.entry2content?.addEventListener('input', () => {
    const e = findEntryByKey(state.selectedId);
    if (!e || e.type !== 'lore') return;
    e.entry2content = el.entry2content.value;
    touchSave();
  });

  el.entry3name?.addEventListener('input', () => {
    const e = findEntryByKey(state.selectedId);
    if (!e || e.type !== 'lore') return;
    e.entry3name = el.entry3name.value;
    touchSave();
  });
  el.entry3content?.addEventListener('input', () => {
    const e = findEntryByKey(state.selectedId);
    if (!e || e.type !== 'lore') return;
    e.entry3content = el.entry3content.value;
    touchSave();
  });

  el.entry4name?.addEventListener('input', () => {
    const e = findEntryByKey(state.selectedId);
    if (!e || e.type !== 'lore') return;
    e.entry4name = el.entry4name.value;
    touchSave();
  });
  el.entry4content?.addEventListener('input', () => {
    const e = findEntryByKey(state.selectedId);
    if (!e || e.type !== 'lore') return;
    e.entry4content = el.entry4content.value;
    touchSave();
  });

  // Top tabs (header) wiring — delegate clicks to switchTab
  try {
    document.querySelectorAll('.top-tab').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        try {
          const t = btn.dataset.tab;
          dbg(`top-tab click -> ${t}`);
          if (t === 'story') {
            switchTab('chapters');
          } else if (t === 'lore') {
            switchTab('lore');
          } else if (t === 'timeline') {
            switchTab('timeline');
          }
        } catch (e) { dbg('top-tab handler error: ' + (e && e.message)); }
      });
    });
  } catch (e) { dbg('top-tab wiring failed: ' + (e && e.message)); }

  // In-editor top-nav buttons (mirror of top tabs)
  try {
    document.getElementById('btn-to-story')?.addEventListener('click', () => switchTab('chapters'));
    document.getElementById('btn-to-lore')?.addEventListener('click', () => switchTab('lore'));
    document.getElementById('btn-to-timeline')?.addEventListener('click', () => switchTab('timeline'));
    document.getElementById('timeline-to-story')?.addEventListener('click', () => switchTab('chapters'));
    document.getElementById('timeline-to-lore')?.addEventListener('click', () => switchTab('lore'));
  } catch (e) { dbg('top-nav button wiring failed: ' + (e && e.message)); }

  // Tabs (writing group) — rebind helpers to ensure handlers exist and are defensive
  function rebindMainTabs() {
    try {
      // Use event delegation on the .tabs-writing container so handlers
      // are reliable regardless of element replace/timing. Mark the
      // container when the delegate is installed to avoid double-binding.
      const container = document.querySelector('.tabs-writing');
      if (!container) return;
  if (container.dataset.hasDelegate) return;
  dbg('rebindMainTabs: installing delegated click handler on .tabs-writing');
      // Install the delegate on document in capture phase to ensure we
      // observe the event even if the .tabs-writing node is replaced later.
      document.addEventListener('click', (e) => {
        try {
          const btn = e.target && e.target.closest ? e.target.closest('.tabs-writing .tab[data-tab]') : null;
          if (!btn) return;
          const t = btn.dataset.tab;
          dbg(`mainTab (doc-delegated) click -> tab=${t}`);
          if (!t) { dbg('mainTab click ignored: missing data-tab'); return; }
          if (t === state.activeTab) { dbg(`mainTab click -> already active ${t}`); return; }
          switchTab(t);
        } catch (err) { dbg(`mainTab doc-delegated handler error: ${err?.message || err}`); }
      }, true);
      container.dataset.hasDelegate = '1';
      dbg('rebindMainTabs: delegated handler installed (document)');
    } catch (e) { dbg(`rebindMainTabs failed: ${e?.message || e}`); }
  }

  // Lore subtabs wiring
  // No lore subtabs: lore is a unified entry type, so we do not bind per-subtab buttons.

// Settings modal open/close
  function closeSettings() {
    dbg("settings: close");
    el.settingsModal?.classList.add("hidden");
  }
  function isSettingsOpen(){ return !!el.settingsModal && !el.settingsModal.classList.contains("hidden"); }

  // Helpers for the new toggle + single select
  function populateAppearanceSelect() {
    if (!el.appearanceSelect || !el.appearanceLabel) return;
    const mode = state.uiPrefs.mode === "background" ? "background" : "theme";
    el.appearanceSelect.innerHTML = "";
    if (mode === "background") {
      el.appearanceLabel.textContent = "Background";
      [["none","None"],["aurora","Aurora"],["space","Space"],["sunset","Sunset"],["ocean","Ocean"]]
        .forEach(([v,label]) => {
          const opt = document.createElement("option");
          opt.value = v; opt.textContent = label; el.appearanceSelect.appendChild(opt);
        });
      el.appearanceSelect.value = state.uiPrefs.bg || "aurora";
      el.appearanceSelect.setAttribute("data-kind","bg");
    } else {
      el.appearanceLabel.textContent = "Theme";
      [["slate","Slate"],["light","Light"],["dark","Dark"],["forest","Forest"],["rose","Rose"]]
        .forEach(([v,label]) => {
          const opt = document.createElement("option");
          opt.value = v; opt.textContent = label; el.appearanceSelect.appendChild(opt);
        });
      el.appearanceSelect.value = state.uiPrefs.theme || "slate";
      el.appearanceSelect.setAttribute("data-kind","theme");
    }
  }

  function openSettings() {
    dbg("settings: open");
    el.settingsModal?.classList.remove("hidden");
    // sync toggle: unchecked=theme, checked=background
    if (el.appearanceMode) el.appearanceMode.checked = (state.uiPrefs.mode === "background");
    populateAppearanceSelect();
    // sliders (opacity now in percent 0..60)
    if (el.bgOpacity) el.bgOpacity.value = String(Math.round((state.uiPrefs.bgOpacity ?? 0.2) * 100));
    if (el.bgBlur) el.bgBlur.value = String(state.uiPrefs.bgBlur ?? 2);
    if (el.editorDim) el.editorDim.checked = !!state.uiPrefs.editorDim;
  }

  el.settingsBtn?.addEventListener("click", openSettings);
  el.settingsClose?.addEventListener("click", closeSettings);
  el.settingsModal?.addEventListener("click", (e) => {
    if (e.target === el.settingsModal) closeSettings();
  });
  // Done (Esc) button closes modal
  el.settingsDone?.addEventListener("click", () => {
    closeSettings();
  });

  // Toggle: unchecked=theme, checked=background
  el.appearanceMode?.addEventListener("change", () => {
    state.uiPrefs.mode = el.appearanceMode.checked ? "background" : "theme";
    dbg(`settings: mode -> ${state.uiPrefs.mode}`);
    populateAppearanceSelect();
    applyThemeAndBackground();
    touchSave();
    saveUIPrefsDebounced();
  });


  // Unified select → updates either theme or background based on data-kind
  el.appearanceSelect?.addEventListener("change", () => {
    const kind = el.appearanceSelect.getAttribute("data-kind") || "theme";
    if (kind === "bg") {
      state.uiPrefs.bg = el.appearanceSelect.value;
      dbg(`settings: bg -> ${state.uiPrefs.bg}`);
    } else {
      state.uiPrefs.theme = el.appearanceSelect.value;
      dbg(`settings: theme -> ${state.uiPrefs.theme}`);
    }
    applyThemeAndBackground();
    touchSave();
    saveUIPrefsDebounced();
  });

  // Opacity slider now in percent (0..60) → store as 0..0.6
  el.bgOpacity?.addEventListener("input", () => {
    const p = parseInt(el.bgOpacity.value, 10);
    const clamped = Number.isFinite(p) ? Math.max(0, Math.min(60, p)) : 20;
    state.uiPrefs.bgOpacity = clamped / 100;
    dbg(`settings: bgOpacity -> ${state.uiPrefs.bgOpacity}`);
    applyThemeAndBackground();
    touchSave();
    saveUIPrefsDebounced();
  });

  el.bgBlur?.addEventListener("input", () => {
    const v = parseInt(el.bgBlur.value, 10);
    state.uiPrefs.bgBlur = Number.isFinite(v) ? Math.max(0, Math.min(8, v)) : 2;
    dbg(`settings: bgBlur -> ${state.uiPrefs.bgBlur}`);
    applyThemeAndBackground();
    touchSave();
    saveUIPrefsDebounced();
  });

  el.editorDim?.addEventListener("change", () => {
    state.uiPrefs.editorDim = !!el.editorDim.checked;
    dbg(`settings: editorDim -> ${state.uiPrefs.editorDim}`);
    applyThemeAndBackground();
    touchSave();
    saveUIPrefsDebounced();
  });


  // Reset to default (mode=theme, Slate; bg=Aurora; opacity 20%; blur 2; dim off)
 el.settingsReset?.addEventListener("click", () => {
    dbg("settings: reset to defaults");
    state.uiPrefs.mode = "theme";
    state.uiPrefs.theme = "slate";
    state.uiPrefs.bg = "aurora";
    state.uiPrefs.bgOpacity = 0.2;
    state.uiPrefs.bgBlur = 2;
    state.uiPrefs.editorDim = false;

    // reflect in controls (toggle + single select + sliders)
    if (el.appearanceMode) el.appearanceMode.checked = false; // theme
    populateAppearanceSelect();
    if (el.bgOpacity) el.bgOpacity.value = String(Math.round(state.uiPrefs.bgOpacity * 100));
    if (el.bgBlur) el.bgBlur.value = String(state.uiPrefs.bgBlur);
    if (el.editorDim) el.editorDim.checked = state.uiPrefs.editorDim;

    applyThemeAndBackground();
    touchSave();
    saveUIPrefsDebounced();
  });

   // Manual Save + Save Back shortcuts + Picker shortcut
  el.saveBtn?.addEventListener("click", () => { saveToDisk(); });

  // NEW: Logout button (if present) → clear session & reload
  const logoutBtn = document.getElementById("logout-btn");
  if (logoutBtn && ipcRenderer) {
    logoutBtn.addEventListener("click", async () => {
      if (!confirm("Logout will remove the current project directory and workspace from this machine. Continue?")) return;
      try {
        // First try to save current state
        if (state.dirty && state.workspacePath) {
          dbg("Saving current state before logout");
          try {
            saveToDisk();
          } catch (e) {
            dbg(`Warning: Failed to save before logout: ${e?.message || e}`);
          }
        }

        if (!state.workspacePath) {
          dbg("No workspace path available for logout");
        } else {
          dbg(`Active workspace for logout: ${state.workspacePath}`);
          dbg(`Project directory: ${state.currentProjectDir || '(none)'}`);
        }

        // First save workspace and project if needed
        if (state.dirty) {
          dbg("Saving workspace and project before logout...");
          const nodeCount = Object.keys(state.timelineNodes || {}).length;
          const linkCount = Object.keys(state.timelineLinks || {}).length;
          dbg("timeline: pre-logout check - nodes: " + nodeCount + ", links: " + linkCount);
          await saveToWorkspaceAndProject();
        }

        // Try to save to DB
        const r = await ipcRenderer.invoke("auth:logout", { 
          projectPath: state.workspacePath || null,
          workspaceExists: state.workspacePath ? fs.existsSync(state.workspacePath) : false 
        });
        
        if (!r?.ok) {
          const error = r?.error || "Unknown error";
          dbg(`Logout failed: ${error}`);
          return alert(`Logout failed: ${error}`);
        }

        dbg("Logout successful, clearing local state");
        // Clear all state
        state.authUser = null;
        state.workspacePath = null;
        state.currentProjectDir = null;
        SAVE_FILE = null;
        
        // Clear timeline data
        clearTimelineData();

        // Remove the existing login modal if it exists
        const oldModal = document.getElementById("login-modal-dynamic");
        if (oldModal) {
          oldModal.remove();
        }
        loginModal = null; // Force recreation of login modal

        // Hide any open pickers/modals
        hideProjectPicker();
        hideLoginModal();

        // Small delay to ensure DOM is ready
        setTimeout(() => {
          ensureLoginModal();
          showLoginModal();
        }, 100);
      } catch (err) {
        alert(`Logout error: ${err?.message || err}`);
      }
    });
  }

  // Delete current entry from the editor button
  el.deleteBtn?.addEventListener("click", () => {
    const cur = findEntryByKey(state.selectedId);
    if (cur) confirmAndDelete(cur.id);
  });

  // Lore editor buttons
  el.loreSwitchBtn?.addEventListener('click', () => {
    dbg('loreSwitchBtn click');
    try { switchTab('lore'); switchToLore(); } catch (e) { dbg(`switchToLore error: ${e?.message || e}`); }
  });
  el.loreBackBtn?.addEventListener('click', () => {
    dbg('loreBackBtn click');
    try { switchToStory(); } catch (e) { dbg(`switchToStory error: ${e?.message || e}`); }
  });
  
  window.addEventListener("keydown", async (e) => {
    const isMac = navigator.platform.toUpperCase().includes("MAC");
    const mod = isMac ? e.metaKey : e.ctrlKey;

    // Save to workspace
    if (mod && e.key.toLowerCase() === "s" && !e.shiftKey) {
      e.preventDefault();
      saveToDisk();
    }

    // Save Back to Documents project
    if (mod && e.shiftKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (!state.workspacePath || !state.currentProjectDir) return alert("No active project to save back.");
      try {
        await saveToWorkspaceAndProject();
        alert(`Workspace saved back to:\n${state.currentProjectDir}`);
      } catch (err) {
        return alert(`Save Back failed:\n${err?.message || String(err)}`);
      }
    }

    // Open Project Picker
    if (mod && e.key.toLowerCase() === "p") {
      e.preventDefault();
      showProjectPicker();
    }

    // Open Quick Finder (Ctrl/Cmd+F)
    if (mod && e.key.toLowerCase() === "f") {
      e.preventDefault();
      showFinder("");
    }

    // Dynamic ESC (B): close settings → finder → picker
    if (e.key === "Escape") {
      // settings first
      if (el.settingsModal && !el.settingsModal.classList.contains("hidden")) {
        e.preventDefault();
        el.settingsModal.classList.add("hidden");
        return;
      }
      // finder
      const f = document.getElementById("finder");
      if (f && f.style.display === "flex") {
        e.preventDefault();
        hideFinder();
        return;
      }
      // project picker
      const p = document.getElementById("project-picker");
      if (p && p.style.display === "flex") {
        e.preventDefault();
        hideProjectPicker();
        return;
      }
    }

    // Delete current entry (Ctrl/Cmd+Delete)
    if (mod && e.key === "Backspace") {
      const cur = findEntryByKey(state.selectedId);
      if (cur) {
        e.preventDefault();
        confirmAndDelete(cur.id);
      }
    }
    // Handle delete command from menu - moved to single registration during init
  });

  // DB sync function - downloads latest data from DB to project directory
  // DB->local sync and related legacy helpers removed from renderer.
  // Functions previously here (syncFromDB, loadRemoteSnapshotIntoState) were intentionally deleted
  // to ensure the UI cannot trigger any DB->local downloads. Keepers: local-only project flows.


  // ───────────────── Init ─────────────────
  document.addEventListener("DOMContentLoaded", async () => {
    try {
      if (el.empty) { el.empty.classList.add("hidden"); el.empty.style.display = "none"; }

      // APPLY VISUALS ON LAUNCH (before any project load)
      ensureAppBg();
      applyThemeAndBackground();

      if (!ipcRenderer) {
        throw new Error("No ipcRenderer; cannot manage projects");
      }

      // Check if user is already logged in
      const auth = await ipcRenderer.invoke("auth:get");
      if (!auth?.ok || !auth.user) {
        dbg("No auth user; showing login modal");
        hideProjectPicker();
        ensureLoginModal();
        showLoginModal();
        return;
      }

      // User is logged in - initialize app state
      state.authUser = auth.user;
      dbg(`Initializing for logged in user: ${auth.user.email}`);

      // Hide any login UI that might exist
      const loginA = document.getElementById("login-screen"); 
      const loginB = document.querySelector('[data-view="login"]');
      if (loginA) loginA.style.display = "none";
      if (loginB) loginB.style.display = "none";

      // Load preferences
      await loadUIPrefs();

      // Initialize project picker without syncing
      const picker = ensureProjectPicker();
      if (picker) {
        showProjectPicker();
        dbg("Showed project picker for logged in user");
      } else {
        throw new Error("Failed to initialize project picker");
      }

    } catch (err) {
      dbg(`Initialization error: ${err?.message || err}`);
      // On error, show login modal as fallback
      hideProjectPicker();
      ensureLoginModal();
      showLoginModal();
    }

     // ───────────── Auth check / Login prompt ─────────────
    try {
      const auth = await ipcRenderer.invoke("auth:get");
      if (auth?.ok && auth.user) {
        state.authUser = auth.user;
        dbg(`auth:get -> signed in as ${auth.user.email}`);
      } else {
        dbg("No auth user; showing login modal");
        hideProjectPicker();         // Ensure picker isn’t visible when signed-out
        showLoginModal();
        return;                      // Stop init here until user logs in
      }
    } catch (e) {
      dbg(`auth:get error: ${e?.message || e}`);
      showLoginModal();
      return;                        // Stop init on error as well
    }

    // Load & apply UI prefs
    await loadUIPrefs();
    
    // Show project picker by default when signed in, without syncing
    ensureProjectPicker();
    showProjectPicker();

    const ap = await ipcRenderer.invoke("project:activePath").catch(e=>({ok:false,error:String(e)}));
    if (!ap?.ok) {
      dbg("activePath query failed; picker remains open.");
      return;
    }

  state.workspacePath = ap.activePath || null;
    state.currentProjectDir = ap.currentProjectDir || null;
    SAVE_FILE = (state.workspacePath && path) ? path.join(state.workspacePath, "data", "project.json") : null;

// PROBE (DB prefs): read workspace path from DB and log it
try {
  const prefs = await ipcRenderer.invoke("prefs:getWorkspacePath");
  if (prefs?.ok) {
    dbg(`DB prefs workspace_root: "${prefs.path || '(empty)'}"`);
  } else {
    dbg(`DB prefs read error: ${prefs?.error || 'unknown'}`);
  }
} catch (e) {
  dbg(`DB prefs invoke failed: ${String(e)}`);
}

// Establish a per-workspace debug log and flush any buffered lines
if (state.workspacePath && path) {
  LOG_FILE = path.join(state.workspacePath, "debug.log");
  try { if (!fs.existsSync(state.workspacePath)) fs.mkdirSync(state.workspacePath, { recursive: true }); } catch {}
  if (_dbgBuf.length) {
    try { fs.appendFileSync(LOG_FILE, _dbgBuf.join("\n") + "\n", "utf8"); _dbgBuf.length = 0; } catch {}
  }
}

if (!state.currentProjectDir || !state.workspacePath) {
  ensureProjectPicker(); showProjectPicker();
  dbg("No project loaded; picker shown.");
  return;
}

  await appLoadFromDisk();
  renderList();
  // Ensure main tab handlers are bound after DOM and data load
  try {
    dbg('DOMContentLoaded: about to call rebindMainTabs');
    rebindMainTabs();
    dbg('DOMContentLoaded: rebindMainTabs returned');
  } catch (e) { dbg(`rebindMainTabs call failed: ${e?.message || e}`); }

  // Register menu IPC handlers once (avoid duplicate listeners)
  try {
    try { ipcRenderer.removeAllListeners && ipcRenderer.removeAllListeners('menu:delete'); } catch (e) {}
    ipcRenderer.on('menu:delete', () => {
      const cur = findEntryByKey(state.selectedId);
      if (cur) confirmAndDelete(cur.id);
    });
    // Timeline menu controls: zoom in/out/reset
    try { ipcRenderer.removeAllListeners && ipcRenderer.removeAllListeners('menu:timelineZoomIn'); } catch (e) {}
    ipcRenderer.on('menu:timelineZoomIn', () => {
      try {
        const cur = state.timelineViewport.scale || 1;
        // Zoom centered on viewport center
        const canvas = ensureTimelineCanvas();
        const rect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
        setTimelineScale(cur * 1.15, rect.left + rect.width / 2, rect.top + rect.height / 2);
      } catch (e) { dbg('menu:timelineZoomIn handler failed: ' + (e && e.message)); }
    });
    try { ipcRenderer.removeAllListeners && ipcRenderer.removeAllListeners('menu:timelineZoomOut'); } catch (e) {}
    ipcRenderer.on('menu:timelineZoomOut', () => {
      try {
        const cur = state.timelineViewport.scale || 1;
        const canvas = ensureTimelineCanvas();
        const rect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
        setTimelineScale(cur / 1.15, rect.left + rect.width / 2, rect.top + rect.height / 2);
      } catch (e) { dbg('menu:timelineZoomOut handler failed: ' + (e && e.message)); }
    });
    try { ipcRenderer.removeAllListeners && ipcRenderer.removeAllListeners('menu:timelineReset'); } catch (e) {}
    ipcRenderer.on('menu:timelineReset', () => {
      try {
        state.timelineViewport.scale = 1;
        state.timelineViewport.tx = 0;
        state.timelineViewport.ty = 0;
        setTimelineTransform();
      } catch (e) { dbg('menu:timelineReset handler failed: ' + (e && e.message)); }
    });
  } catch (e) { dbg(`Failed to register menu:delete handler: ${e?.message || e}`); }

    // Ensure BG node exists, then apply theme/bg
    ensureAppBg();
    applyThemeAndBackground();

    startFailsafeTimer();
    dbg(`Workspace ready: ${SAVE_FILE}`);
  });

    // Global capture-phase logging for sidebar clicks to diagnose swallowed events.
    // Logs only when clicks occur inside the .sidebar element.
    try {
      document.addEventListener('click', function(ev) {
        try {
          var tg = ev.target;
          if (!tg || !tg.closest) return;
          var inSidebar = !!tg.closest('.sidebar');
          if (!inSidebar) return;
          var tabAnc = tg.closest('.tab');
          var tabName = (tabAnc && tabAnc.dataset) ? tabAnc.dataset.tab : null;
          dbg('[CAPTURE] sidebar click target=' + (tg.tagName || '') + ' id=' + (tg.id||'') + ' classes=' + (tg.className||'') + ' tabAncestor=' + (tabName||'none') + ' isTrusted=' + (!!ev.isTrusted));
        } catch (err) { dbg('[CAPTURE] error ' + (err && err.message)); }
      }, true);
    } catch (e) { dbg('Failed to install capture-phase sidebar click logger: ' + (e && e.message)); }

  })();
