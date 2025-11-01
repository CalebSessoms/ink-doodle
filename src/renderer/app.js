// src/renderer/app.js
// Project Picker + Workspace I/O + Drag-and-Drop Reorder + Delete + Menu integration + Autosave
/* eslint-disable @typescript-eslint/no-var-requires */

(() => {
  "use strict";

/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');

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

  // ───────────────── Global/State ─────────────────
  const state = {
    projectName: "Untitled Project",
    activeTab: "chapters", // "chapters" | "notes" | "references"
    entries: [],           // { id, type, title, ... }
    selectedId: null,
    counters: { chapter: 1, note: 1, reference: 1 },

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
    tabs: $$(".tab"),
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
  };

  // ───────────────── Utilities ─────────────────
  const nowISO = () => new Date().toISOString();
  const uid = () => Math.random().toString(36).slice(2, 10);
  const capFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  const tabTypeMap = { chapters: "chapter", notes: "note", references: "reference" };
  const typeTabMap = { chapter: "chapters", note: "notes", reference: "references" };

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

  // Load first remote project (for the signed-in user) + its chapters (read-only)
  async function loadRemoteSnapshotIntoState() {
    if (!ipcRenderer) return;

    // First check if sync is enabled
    const syncEnabled = await ipcRenderer.invoke('sync:isEnabled')
      .catch(() => false);
    
    if (!syncEnabled) {
      dbg('Remote snapshot load skipped - DB sync is disabled');
      return;
    }

    // 1) list remote projects for current auth user
    const projRes = await ipcRenderer.invoke("projects:listRemote").catch(e => ({ ok:false, error:String(e) }));
    if (!projRes?.ok || !Array.isArray(projRes.items) || projRes.items.length === 0) {
      dbg(`remote load skipped: ${projRes?.error || "no remote projects found"}`);
      return;
    }
    const first = projRes.items[0];
    const projectId = first.id;
    dbg(`remote: using project ${first.title || projectId}`);

    // 2) chapters for that project (pass numeric id)
    const chRes = await ipcRenderer.invoke("chapters:listByProject", { projectIdOrCode: String(projectId) })
      .catch(e => ({ ok:false, error:String(e) }));
    if (!chRes?.ok) {
      dbg(`remote chapters load failed: ${chRes?.error || "unknown error"}`);
      return;
    }

    // 3) map → state and render (read-only swap)
    const chapters = mapDbChapters(chRes.items || []);
    const others = state.entries.filter(e => e.type !== "chapter");
    state.entries = chapters.concat(others);

    const vis = visibleEntries();
      if (!state.selectedId && vis.length) state.selectedId = entryKey(vis[0]);
    if (state.selectedId && !findEntryByKey(state.selectedId) && vis.length) {
      state.selectedId = entryKey(vis[0]);
    }

    renderList();
    dbg(`remote: loaded ${chapters.length} chapters into UI (read-only).`);
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
                         `Untitled Reference ${nextNum}`;
  return label;
  }

  function visibleEntries() {
    const t = tabTypeMap[state.activeTab];
    return state.entries.filter(e => e.type === t).sort((a,b)=>a.order_index - b.order_index);
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
        const res = await ipcRenderer.invoke("project:saveBack", { workspacePath: state.workspacePath, projectDir: state.currentProjectDir }).catch(e=>({ok:false,error:String(e)}));
        if (!res?.ok) {
          dbg(`Save back failed: ${res?.error || "Unknown error"}`);
          return alert(`Save Back failed:\n${res?.error||"Unknown error"}`);
        }
        dbg(`Project saved back to: ${res.target || state.currentProjectDir}`);
        alert(`Workspace saved back to:\n${res.target || state.currentProjectDir}`);
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
    
    // Only sync if enabled
    const syncEnabled = await ipcRenderer.invoke('sync:isEnabled')
      .catch(() => false);

    if (syncEnabled) {
      dbg("Syncing with DB before showing project picker...");
      const syncResult = await ipcRenderer.invoke("db:syncFromDB");
      if (!syncResult.ok) {
        dbg(`Warning: DB sync failed: ${syncResult.error}`);
      } else {
        dbg(`DB sync completed: ${syncResult.projectCount} projects synced`);
      }
    } else {
      dbg("DB sync disabled - skipping sync before showing picker");
    }
    
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

  dbg(`renderList — rendering ${list.length} visible entries (activeTab=${state.activeTab} selected=${state.selectedId})`);
  list.forEach((e, idx) => {
      const li = document.createElement("li");
  li.className = "entry" + (entryKey(e) === state.selectedId ? " selected" : "");
      li.dataset.id = e.id;
      li.dataset.type = e.type;
      li.draggable = true;

      const t = document.createElement("span");
      t.className = "title";
      t.textContent = e.title || "(Untitled)";

      const m = document.createElement("span");
      m.className = "meta";
      m.textContent = metaText(e);

      const spacer = document.createElement("span"); // keeps delete on far right
      spacer.className = "spacer";

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
        ev.dataTransfer.setData("text/plain", e.id);
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

    if (!state.selectedId && list.length > 0) {
      state.selectedId = entryKey(list[0]);
      dbg(`renderList — no selection; defaulting to ${state.selectedId}`);
      populateEditor(list[0]);
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
    const entry = state.entries.find(e => e.id === id);
    if (!entry) return;
    const kind = entry.type === "chapter" ? "Chapter" :
                 entry.type === "note" ? "Note" : "Reference";
    const name = entry.title || `(Untitled ${kind})`;
    if (!confirm(`Delete ${kind}:\n"${name}"?\nThis cannot be undone.`)) return;
    deleteEntry(id);
  }

  function deleteEntry(id) {
    const entry = state.entries.find(e => e.id === id);
    if (!entry) return;
    const type = entry.type;

    // Remove from state
    state.entries = state.entries.filter(e => e.id !== id);

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
      if (el.sourceLink) el.sourceLink.value = entry.source_link || "";
      if (el.body) el.body.value = entry.body || "";
    }

    el.saveState && (el.saveState.textContent = "Autosaved");
    updateWordCount();
  }

  // ───────────────── Create ─────────────────
  function createEntry(kind) {
    const type = kind;
    const order_index = state.entries.filter(e => e.type === type).length;
    
    // Increment counter for this type first
    state.counters[type] = (state.counters[type] || 0) + 1;
    const count = state.counters[type];

    // Determine project id to use as parent in entry codes
    const projectId = Number(state.project?.id || state.project?.project_id) || 0;
    const pad = (n) => String(n).padStart(6, '0');
    const parentPad = String(projectId).padStart(4, '0');
    const typeCode = type === 'chapter' ? 'CHP' : type === 'note' ? 'NT' : 'RF';

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
    }
    else { 
      entry.reference_type = "Glossary";
      entry.summary = "";
      entry.source_link = "";
      dbg(`reference:create — Creating new reference "${entry.title}" with ID ${entry.id}`);
    }

  // Add to state.entries with proper project code if available
  entry.project_code = state.project?.code;
    state.entries.push(entry);
    
    // Switch to correct tab if needed
    const target = typeTabMap[type];
    if (state.activeTab !== target) {
      dbg(`Tab switch needed for new ${type}: ${state.activeTab} -> ${target}`);
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
      if (el.titleInput) {
        el.titleInput.focus();
        el.titleInput.select();
      }
    }, 50);

    // Save changes
    touchSave(true);
    dbg(`created ${type} "${entry.title}" (ID: ${entry.id}) and selected it - pending save`);
  }

  // ───────────────── Tabs ─────────────────
  function switchTab(tabName) {
    state.activeTab = tabName;
    el.tabs?.forEach(t => {
      const active = t.dataset.tab === tabName;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    });
    renderList();
    dbg(`switched tab -> ${tabName}`);
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
              refs: data.refs
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
      refs: { added: [], updated: [], deleted: [] }
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
        ['chapters', 'notes', 'refs'].forEach(dir => {
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
                    entry.type === 'note' ? 'notes' : 'refs';
                    
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
          for (const entry of state.entries) {
        const type = entry.type === 'chapter' ? 'chapters' : 
                    entry.type === 'note' ? 'notes' : 'refs';
                    
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
            const prefix = entry.type === 'chapter' ? 'CH' : entry.type === 'note' ? 'NT' : 'RF';
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
            reference: ['id','code','project_id','creator_id','title','content','body','tags','reference_type','summary','source_link','created_at','updated_at']
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

          // Do not write order_index into per-item files; project-level ordering belongs in data/project.json

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
  const entryTypes = ['chapters', 'notes', 'refs'];
  const entries = [];
  // per-type counters for debug reporting
  const loadStats = { chapters: 0, notes: 0, refs: 0 };
        
        for (const type of entryTypes) {
          const typeDir = path.join(projectRootDir, type);
          if (fs.existsSync(typeDir)) {
            const files = fs.readdirSync(typeDir).filter(f => f.endsWith('.json'));
            for (const file of files) {
              try {
                const entryPath = path.join(typeDir, file);
                const raw = JSON.parse(fs.readFileSync(entryPath, 'utf8'));

                // Build a lightweight view for UI while preserving the original raw object and filename
                const inferredType = type === 'chapters' ? 'chapter' : type === 'notes' ? 'note' : 'reference';
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

                entries.push(view);
                loadStats[type] = (loadStats[type] || 0) + 1;
                dbg(`workspace:load — read ${type}/${file} (id=${view.id ?? 'n/a'} code=${view.code ?? 'n/a'})`);
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
            const m = view.__filename.match(/^(CH|NT|RF)(\d+)\.json$/i);
            if (m) {
              const prefix = m[1].toUpperCase();
              const n = parseInt(m[2], 10);
              if (prefix === 'CH') code = `CHP-${parentPad}-${pad(n)}`;
              else if (prefix === 'NT') code = `NT-${parentPad}-${pad(n)}`;
              else if (prefix === 'RF') code = `RF-${parentPad}-${pad(n)}`;
            }
          }

          // If we still don't have a code but view.id is numeric, synthesize a code for UI only
          if (!code && typeof view.id === 'number') {
            if (view.type === 'chapter') code = `CHP-${parentPad}-${pad(view.id)}`;
            else if (view.type === 'note') code = `NT-${parentPad}-${pad(view.id)}`;
            else if (view.type === 'reference') code = `RF-${parentPad}-${pad(view.id)}`;
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
            reference: ['id','code','project_id','creator_id','title','content','body','tags','reference_type','summary','source_link','created_at','updated_at','order_index']
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
            const typ = ent.type || (ent.__raw && ent.__raw.type) || (ent.code && (String(ent.code).startsWith('CHP') ? 'chapter' : String(ent.code).startsWith('NT') ? 'note' : String(ent.code).startsWith('RF') ? 'reference' : null));
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
        dbg(`workspace:load — entries loaded: chapters=${loadStats.chapters}, notes=${loadStats.notes}, refs=${loadStats.refs}; canonical entries=${data.entries.length}`);

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
    if (!state.dirty) {
      dbg(`workspace:save — No changes to save`);
      return;
    }
    
    try {
      dbg(`workspace:save — Starting save of workspace changes`);
      saveToDisk(); // Ensure changes are written to disk first
      
      dbg(`db:sync — Starting sync of workspace changes to DB`);
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
      const r = await ipcRenderer.invoke("project:save-back", {
        workspaceFile: SAVE_FILE
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
    const kind = tabTypeMap[state.activeTab];
    createEntry(kind);
  });

  // Hidden empty-state quick create (overlay unused)
  el.quickCreate?.forEach(btn => {
    btn.addEventListener("click", () => {
      const kind = btn.dataset.new;
      createEntry(kind);
    });
  });

  // Tabs
  el.tabs?.forEach(tab => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

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
      const res = await ipcRenderer.invoke("project:saveBack", { workspacePath: state.workspacePath, projectDir: state.currentProjectDir }).catch(err=>({ok:false,error:String(err)}));
  if (!res?.ok) return alert(`Save Back failed:\n${res?.error||"Unknown error"}`);
  alert(`Workspace saved back to:\n${res.target || state.currentProjectDir}`);
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
  });

  // Menu → Renderer listeners
  if (ipcRenderer) {
    ipcRenderer.on("menu:save", () => { saveToDisk(); });
    ipcRenderer.on("menu:saveBack", async () => {
      if (!state.workspacePath || !state.currentProjectDir) return alert("No active project to save back.");
      const res = await ipcRenderer.invoke("project:saveBack", { workspacePath: state.workspacePath, projectDir: state.currentProjectDir }).catch(err => ({ ok:false, error:String(err) }));
  if (!res?.ok) return alert(`Save Back failed:\n${res?.error||"Unknown error"}`);
  alert(`Workspace saved back to:\n${res.target || state.currentProjectDir}`);
    });
    ipcRenderer.on("menu:openPicker", () => { showProjectPicker(); });
    ipcRenderer.on("menu:openFinder", () => { showFinder(""); });
    
     // Handle delete command from menu
    ipcRenderer.on("menu:delete", () => {
      const cur = findEntryByKey(state.selectedId);
      if (cur) confirmAndDelete(cur.id);
    });
  }

  // DB sync function - downloads latest data from DB to project directory
  async function syncFromDB() {
    try {
      // First check if sync is enabled
      const syncEnabled = await ipcRenderer.invoke('sync:isEnabled')
        .catch(() => false);
      
      if (!syncEnabled) {
        dbg("DB sync skipped - sync is disabled");
        return false;
      }

      const auth = await ipcRenderer.invoke("auth:get");
      if (!auth?.ok || !auth.user) {
        dbg("DB sync skipped - no user logged in");
        return false;
      }
      
      dbg("Starting DB sync...");
      const syncResult = await ipcRenderer.invoke("db:syncFromDB");
      if (!syncResult?.ok) {
        throw new Error(syncResult?.error || "Unknown error during sync");
      }

      // After sync, refresh the project picker if it exists
      if (picker) {
        await refreshProjectList();
        dbg("Refreshed project list after sync");
      }

      // If we have a current project loaded, reload it to get latest changes
      if (state.currentProjectDir && state.workspacePath) {
        try {
          await appLoadFromDisk();
          dbg("Reloaded current project after sync");
        } catch (loadErr) {
          dbg(`Warning: Could not reload current project: ${loadErr.message}`);
        }
      }

      dbg(`DB sync successful - synced ${syncResult.projectCount} projects`);
      return true;
    } catch (err) {
      dbg(`DB sync error: ${err?.message || err}`);
      throw err; // Re-throw to handle in calling code
    }
  }
  
  // Legacy function kept for compatibility
  async function loadRemoteSnapshotIntoState() {
    dbg("remote: loadRemoteSnapshotIntoState redirected to syncFromDB");
    await syncFromDB();
  }


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

    // Ensure BG node exists, then apply theme/bg
    ensureAppBg();
    applyThemeAndBackground();

    startFailsafeTimer();
    dbg(`Workspace ready: ${SAVE_FILE}`);
  });

})();
