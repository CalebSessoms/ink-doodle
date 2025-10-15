// src/renderer/app.js
// Project Picker + Workspace I/O + Drag-and-Drop Reorder + Delete + Menu integration + Autosave

(() => {
  "use strict";

  // ───────────────── Debug helpers ─────────────────
  function dbg(msg) {
    console.log("[debug]", msg);
    const b = document.getElementById("debug-banner");
    if (b) b.textContent = `[debug] ${msg}`;
  }
  (function banner() {
    const b = document.createElement("div");
    b.id = "debug-banner";
    b.style.cssText =
      "position:fixed;right:8px;bottom:8px;z-index:99999;background:#111827;color:#e5e7eb;padding:8px 10px;border-radius:8px;font:12px/1.2 -apple-system,Segoe UI,Roboto,Inter,sans-serif;opacity:.9;max-width:520px;box-shadow:0 6px 20px rgba(0,0,0,.25)";
    b.textContent = "[debug] boot…";
    document.addEventListener("DOMContentLoaded", () => document.body.appendChild(b));
  })();

  // ───────────────── Node & Electron ─────────────────
  let fs = null, path = null, ipcRenderer = null;
  try {
    fs = require("fs");
    path = require("path");
    ({ ipcRenderer } = require("electron"));
    dbg("require(fs,path,ipcRenderer) OK");
  } catch (e) {
    dbg("Node/Electron require failed; check nodeIntegration/contextIsolation.");
    console.error(e);
  }

  // ───────────────── Global/State ─────────────────
  const state = {
    projectName: "Untitled Project",
    activeTab: "chapters", // "chapters" | "notes" | "references"
    entries: [],           // { id, type, title, ... }
    selectedId: null,
    counters: { chapter: 1, note: 1, reference: 1 },

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
    // Status/footer
    wordCount: $("#word-count"),
    saveState: $("#save-state"),
    lastSaved: $("#last-saved"),
    saveBtn: $("#save-btn"),
    deleteBtn: $("#editor-delete-btn"),
  };

  // ───────────────── Utilities ─────────────────
  const nowISO = () => new Date().toISOString();
  const uid = () => Math.random().toString(36).slice(2, 10);
  const capFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  const tabTypeMap = { chapters: "chapter", notes: "note", references: "reference" };
  const typeTabMap = { chapter: "chapters", note: "notes", reference: "references" };

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
          <div style="display:flex; gap:8px;">
            <input id="pp-newname" placeholder="Project name" style="flex:1; padding:8px; border:1px solid #e5e7eb; border-radius:8px;"/>
            <button id="pp-create" class="btn primary">Create</button>
          </div>
          <div style="font-size:12px; color:#6b7280; margin-top:6px;">
            Projects are stored under your Documents/InkDoodleProjects folder.
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
      .pp-item { border:1px solid #e5e7eb; border-radius:8px; padding:10px; display:flex; justify-content:space-between; align-items:center; }
      .pp-title { font-weight:600; }
      .pp-path { color:#6b7280; font-size:12px; }
      .pp-actions { display:flex; gap:8px; }
    `;
    document.head.appendChild(style);

    $("#pp-close").addEventListener("click", () => hideProjectPicker());
    $("#pp-refresh").addEventListener("click", () => refreshProjectList());
    $("#pp-saveback").addEventListener("click", async () => {
      const res = await ipcRenderer.invoke("project:saveBack").catch(e=>({ok:false,error:String(e)}));
      if (!res?.ok) return alert(`Save Back failed:\n${res?.error||"Unknown error"}`);
      alert(`Workspace saved back to:\n${res.target}`);
    });
    $("#pp-create").addEventListener("click", async () => {
      const name = $("#pp-newname").value.trim();
      if (!name) return alert("Please enter a project name.");
      const res = await ipcRenderer.invoke("project:new", { name }).catch(e=>({ok:false,error:String(e)}));
      if (!res?.ok) return alert(`Create failed:\n${res?.error||"Unknown error"}`);
      $("#pp-newname").value = "";
      await refreshProjectList();
    });

    return picker;
  }

  function showProjectPicker() {
    ensureProjectPicker();
    picker.style.display = "flex";
    refreshProjectList();
  }
  function hideProjectPicker() {
    if (!picker) return;
    picker.style.display = "none";
  }

  async function refreshProjectList() {
    const rootEl = $("#pp-root");
    const listEl = $("#pp-list");
    rootEl.textContent = "Loading…";
    listEl.innerHTML = "";

    const res = await ipcRenderer.invoke("project:list").catch(e=>({ok:false,error:String(e)}));
    if (!res?.ok) {
      rootEl.textContent = "Failed to list projects.";
      alert(res?.error||"Unknown error");
      return;
    }
    rootEl.textContent = res.root;

    if (!res.items.length) {
      listEl.innerHTML = `<div class="pp-item"><div>No projects yet. Create one on the right.</div></div>`;
      return;
    }

    for (const item of res.items) {
      const row = document.createElement("div");
      row.className = "pp-item";
      row.innerHTML = `
        <div>
          <div class="pp-title">${item.name}</div>
          <div class="pp-path">${item.dir}</div>
        </div>
        <div class="pp-actions">
          <button class="btn" data-act="load">Load</button>
          <button class="btn" data-act="delete">Delete</button>
        </div>
      `;
      row.querySelector('[data-act="load"]').addEventListener("click", async () => {
        const r = await ipcRenderer.invoke("project:load", { dir: item.dir }).catch(e=>({ok:false,error:String(e)}));
        if (!r?.ok) return alert(`Load failed:\n${r?.error||"Unknown error"}`);

        // use returned activePath/currentProjectDir
        state.workspacePath = r.activePath;
        state.currentProjectDir = r.currentProjectDir || item.dir;
        SAVE_FILE = path.join(state.workspacePath, "data", "project.json");

        await appLoadFromDisk(); // load from workspace
        hideProjectPicker();
        dbg(`Switched project: workspace -> ${state.workspacePath}`);
      });
      row.querySelector('[data-act="delete"]').addEventListener("click", async () => {
        if (!confirm(`Delete project "${item.name}"?\nThis removes the folder:\n${item.dir}`)) return;
        const r = await ipcRenderer.invoke("project:delete", { dir: item.dir }).catch(e=>({ok:false,error:String(e)}));
        if (!r?.ok) return alert(`Delete failed:\n${r?.error||"Unknown error"}`);
        await refreshProjectList();
      });
      listEl.appendChild(row);
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

    list.forEach((e, idx) => {
      const li = document.createElement("li");
      li.className = "entry" + (e.id === state.selectedId ? " selected" : "");
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
      li.addEventListener("click", () => selectEntry(e.id));

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
      state.selectedId = list[0].id;
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

    if (state.selectedId === id) {
      state.selectedId = nextId;
      if (nextId) {
        const next = state.entries.find(e => e.id === nextId);
        if (next) populateEditor(next); else clearEditor();
      } else {
        clearEditor();
      }
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
    if (el.noteCategory) el.noteCategory.value = "Misc";
    if (el.notePin) el.notePin.checked = false;
    if (el.referenceType) el.referenceType.value = "Glossary";
    if (el.sourceLink) el.sourceLink.value = "";
    updateWordCount();
  }

  function selectEntry(id) {
    state.selectedId = id;
    const entry = state.entries.find(e => e.id === id);
    if (entry) populateEditor(entry);
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
    } else if (entry.type === "note") {
      hide(el.statusWrapper); show(el.tagsWrapper); hide(el.synopsisLabel); hide(el.synopsis);
      show(el.noteCategoryWrapper); show(el.notePinWrapper);
      hide(el.referenceTypeWrapper); hide(el.sourceLinkLabel); hide(el.sourceLink);
      if (el.tags) el.tags.value = (entry.tags || []).join(", ");
      if (el.noteCategory) el.noteCategory.value = entry.category || "Misc";
      if (el.notePin) el.notePin.checked = !!entry.pinned;
      if (el.body) el.body.value = entry.body || "";
    } else if (entry.type === "reference") {
      hide(el.statusWrapper); show(el.tagsWrapper); show(el.synopsisLabel); show(el.synopsis);
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
    const entry = {
      id: uid(), type, title: defaultUntitled(type),
      updated_at: nowISO(), order_index, body: "", tags: []
    };
    if (type === "chapter") { entry.status = "Draft"; entry.synopsis = ""; }
    else if (type === "note") { entry.category = "Misc"; entry.pinned = false; }
    else { entry.reference_type = "Glossary"; entry.summary = ""; entry.source_link = ""; }

    state.entries.push(entry);
    const target = typeTabMap[type];
    if (state.activeTab !== target) switchTab(target);
    selectEntry(entry.id);
    el.titleInput?.focus();
    touchSave(true);
    dbg(`created ${type} "${entry.title}" and selected it`);
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
    const cur = state.entries.find(e => e.id === state.selectedId);
    if (!el.wordCount) return;
    if (!cur) { el.wordCount.textContent = "Words: 0"; return; }
    if (cur.type !== "chapter") { el.wordCount.textContent = "Words: —"; return; }
    const text = el.body?.value || "";
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    el.wordCount.textContent = `Words: ${words}`;
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

  function collectProjectData() {
    const cur = state.entries.find(e => e.id === state.selectedId);
    if (cur) {
      cur.title = el.titleInput?.value || cur.title;
      if (cur.type === "chapter") {
        cur.status = el.status?.value || "Draft";
        cur.tags = parseTags(el.tags?.value);
        cur.synopsis = el.synopsis?.value || "";
        cur.body = el.body?.value || "";
      } else if (cur.type === "note") {
        cur.tags = parseTags(el.tags?.value);
        cur.category = el.noteCategory?.value || "Misc";
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
    state.projectName = (el.projectName?.textContent || "").trim() || "Untitled Project";

    return {
      project: { name: state.projectName, saved_at: nowISO() },
      entries: state.entries.map(stripUndefined),
      ui: { activeTab: state.activeTab, selectedId: state.selectedId, counters: state.counters },
      version: 1,
    };
  }

  function saveToDisk() {
    if (!fs || !path || !SAVE_FILE) {
      const msg = "Save disabled: no workspace path. Load/create a project first.";
      dbg(msg); alert(msg); return;
    }
    try {
      const data = collectProjectData();
      ensureDir(SAVE_FILE);
      fs.writeFileSync(SAVE_FILE, JSON.stringify(data, null, 2), "utf8");
      const t = new Date();
      el.lastSaved && (el.lastSaved.textContent = `Last saved • ${t.toLocaleTimeString()}`);
      el.saveState && (el.saveState.textContent = "Saved");
      state.dirty = false;
      state.lastSavedAt = Date.now();
      dbg(`Saved OK → ${SAVE_FILE}`);
      renderList();
    } catch (err) {
      console.error(err);
      el.saveState && (el.saveState.textContent = "Save error");
      alert(`Save failed:\n${err?.message || err}\nPath: ${SAVE_FILE}`);
    }
  }

  async function appLoadFromDisk() {
    if (!fs || !path || !SAVE_FILE) { dbg("Load skipped: no workspace path"); return; }
    try {
      if (!fs.existsSync(SAVE_FILE)) { dbg("No project.json in workspace; starting fresh"); return; }
      const raw = fs.readFileSync(SAVE_FILE, "utf8");
      const data = JSON.parse(raw);

      state.projectName = data?.project?.name || "Untitled Project";
      if (el.projectName) el.projectName.textContent = state.projectName;

      state.entries = Array.isArray(data?.entries) ? data.entries : [];
      normalizeOrderIndexes();

      const ui = data?.ui || {};
      state.activeTab = ui.activeTab || "chapters";
      state.selectedId = ui.selectedId || (visibleEntries()[0]?.id ?? null);
      state.counters = ui.counters || state.counters;
      if (!ui.counters) deriveCountersIfMissing();

      el.tabs?.forEach(t => {
        const active = t.dataset.tab === state.activeTab;
        t.classList.toggle("active", active);
        t.setAttribute("aria-selected", active ? "true" : "false");
      });

      const sel = state.entries.find(e=>e.id===state.selectedId) || visibleEntries()[0];
      if (sel) { state.selectedId = sel.id; populateEditor(sel); }

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
  function touchSave() {
    markDirty();
    scheduleAutosave();
    clearTimeout(_fakeAutosaveUI);
    _fakeAutosaveUI = setTimeout(() => {
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

  // ───────────────── Wiring ─────────────────
  el.projectName?.addEventListener("input", () => {
    state.projectName = (el.projectName.textContent || "").trim() || "Untitled Project";
    touchSave();
  });
  el.titleInput?.addEventListener("input", () => {
    const e = state.entries.find(x => x.id === state.selectedId);
    if (!e) return;
    e.title = el.titleInput.value;
    renderList();
    touchSave();
  });
  el.status?.addEventListener("change", () => {
    const e = state.entries.find(x => x.id === state.selectedId);
    if (!e || e.type !== "chapter") return;
    e.status = el.status.value;
    renderList();
    touchSave();
  });
  el.tags?.addEventListener("blur", () => {
    const e = state.entries.find(x => x.id === state.selectedId);
    if (!e) return;
    e.tags = parseTags(el.tags.value);
    touchSave();
  });
  el.synopsis?.addEventListener("input", () => {
    const e = state.entries.find(x => x.id === state.selectedId);
    if (!e) return;
    if (e.type === "chapter") e.synopsis = el.synopsis.value;
    else if (e.type === "reference") e.summary = el.synopsis.value;
    touchSave();
  });
  el.body?.addEventListener("input", () => {
    const e = state.entries.find(x => x.id === state.selectedId);
    if (!e) return;
    e.body = el.body.value;
    updateWordCount();
    touchSave();
  });
  // Notes-only
  el.noteCategory?.addEventListener("change", () => {
    const e = state.entries.find(x => x.id === state.selectedId);
    if (!e || e.type !== "note") return;
    e.category = el.noteCategory.value;
    touchSave();
  });
  el.notePin?.addEventListener("change", () => {
    const e = state.entries.find(x => x.id === state.selectedId);
    if (!e || e.type !== "note") return;
    e.pinned = !!el.notePin.checked;
    touchSave();
  });
  // References-only
  el.referenceType?.addEventListener("change", () => {
    const e = state.entries.find(x => x.id === state.selectedId);
    if (!e || e.type !== "reference") return;
    e.reference_type = el.referenceType.value;
    touchSave();
  });
  el.sourceLink?.addEventListener("input", () => {
    const e = state.entries.find(x => x.id === state.selectedId);
    if (!e || e.type !== "reference") return;
    e.source_link = el.sourceLink.value;
    touchSave();
  });

  // + New (sidebar)
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

  // Manual Save + Save Back shortcuts + Picker shortcut
  el.saveBtn?.addEventListener("click", () => { saveToDisk(); });

  // Delete current entry from the editor button
  el.deleteBtn?.addEventListener("click", () => {
    const cur = state.entries.find(x => x.id === state.selectedId);
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
      const res = await ipcRenderer.invoke("project:saveBack").catch(err=>({ok:false,error:String(err)}));
      if (!res?.ok) return alert(`Save Back failed:\n${res?.error||"Unknown error"}`);
      alert(`Workspace saved back to:\n${res.target}`);
    }

    // Open Project Picker
    if (mod && e.key.toLowerCase() === "p") {
      e.preventDefault();
      showProjectPicker();
    }

    // Open Quick Finder (Ctrl/Cmd+F)  // ADDED
    if (mod && e.key.toLowerCase() === "f") { // ADDED
      e.preventDefault();                      // ADDED
      showFinder("");                          // ADDED
    }

    // Delete current entry (Ctrl/Cmd+Delete)
    if (mod && e.key === "Backspace") {
      const cur = state.entries.find(x => x.id === state.selectedId);
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
      const res = await ipcRenderer.invoke("project:saveBack").catch(err => ({ ok:false, error:String(err) }));
      if (!res?.ok) return alert(`Save Back failed:\n${res?.error||"Unknown error"}`);
      alert(`Workspace saved back to:\n${res.target}`);
    });
    ipcRenderer.on("menu:openPicker", () => { showProjectPicker(); });
    ipcRenderer.on("menu:openFinder", () => { showFinder(""); });
    
    // Handle delete command from menu
    ipcRenderer.on("menu:delete", () => {
      const cur = state.entries.find(x => x.id === state.selectedId);
      if (cur) confirmAndDelete(cur.id);
    });
  }

  // ───────────────── Init ─────────────────
  (async function init() {
    if (el.empty) { el.empty.classList.add("hidden"); el.empty.style.display = "none"; }

    if (!ipcRenderer) {
      dbg("No ipcRenderer; cannot manage projects. Proceeding without project picker.");
      return;
    }

    const ap = await ipcRenderer.invoke("project:activePath").catch(e=>({ok:false,error:String(e)}));
    if (!ap?.ok) {
      dbg("activePath query failed; showing picker.");
      ensureProjectPicker(); showProjectPicker();
      return;
    }

    state.workspacePath = ap.activePath || null;
    state.currentProjectDir = ap.currentProjectDir || null;
    SAVE_FILE = (state.workspacePath && path) ? path.join(state.workspacePath, "data", "project.json") : null;

    if (!state.currentProjectDir || !state.workspacePath) {
      ensureProjectPicker(); showProjectPicker();
      dbg("No project loaded; picker shown.");
      return;
    }

    await appLoadFromDisk();
    renderList();
    startFailsafeTimer();
    dbg(`Workspace ready: ${SAVE_FILE}`);
  })();

})();
