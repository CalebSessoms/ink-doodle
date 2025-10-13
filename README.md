# Ink Doodle
A Creative Writing & Worldbuilding App for Fiction Authors

Ink Doodle is a lightweight desktop app built with Electron and JavaScript that helps writers plan and organize long-form fiction projects.  
It is designed for novelists, storytellers, and worldbuilders, focusing on structure and lore organization rather than raw text editing.

---

## Features (Current)
- Chapters, Notes, and References — Create, edit, and manage different entry types.
- Autosave Engine — Automatically saves your work after a brief period of inactivity and on focus/tab/window changes.
- Drag & Drop Reordering — Rearrange entries within their lists.
- Entry Deletion — Delete entries from within the editor; menu action and keybind supported.
- Multiple Projects — Create, switch, and manage separate projects with an integrated project picker.
- Workspace and Save-Back System — Projects are stored in your Documents folder (`InkDoodleProjects`), with a local workspace for active editing.
- Keyboard Shortcuts  
  - Ctrl + S — Save workspace  
  - Ctrl + Shift + S — Save back to project directory  
  - Ctrl + P — Open project picker  
  - Ctrl + Backspace — Delete current entry

---

## Installation & Setup

### Prerequisites
- Node.js (LTS version recommended)
- Git
- VS Code (recommended for editing)

### Setup Steps
```bash
git clone https://github.com/CalebSessoms/ink-doodle.git
cd ink-doodle
npm install
npm start
```

---

## Project Structure
```
ink-doodle/
├── index.js                # Electron main process (menus, project I/O, IPC)
├── index.html              # UI layout
├── src/
│   └── renderer/
│       ├── app.js          # Frontend logic: state, autosave, DnD, editor wiring
│       └── app.css         # Styling
├── package.json
└── README.md
```

---

## Planned Development Milestones

### Week 3 — Core Writing Environment (Prototype)
**Goal:** Fully functional workspace for basic writing and project management.
- UI layout (sidebar, editor, menu integration)
- Create/edit Chapters, Notes, References
- Autosave and word count for chapters
- Drag-and-drop reordering of entries
- Entry deletion via button and keybind
- Multi-project system (picker, save-back integration)

### Week 5 — Lore and Data Management (Expansion)
**Goal:** Extend the system to support structured worldbuilding.
- Add lore categories (Characters, Locations, History, etc.)
- Implement tag-based filtering and search
- Introduce relationships between lore and chapters
- Persistent metadata and project summaries
- Improved autosave stability and undo/redo polish

### Week 7 — Visualization and Advanced Tools (Final)
**Goal:** Visualization and export systems.
- Add relationship web / node graph
- Project overview dashboard (counts, recent edits, status summary)
- Export to Markdown / JSON / plain text
- Initial groundwork for publishing tools
- UI polish, testing, and optimization

---

## Future Features and Long-Term Goals
- Relationship graph refinements (draggable nodes, grouping, color-coding)
- Advanced search and filtering with multi-tag logic and saved filters
- Rich export flows (full project export, per-entry export, templated exports)
- Import tools for existing drafts and worldbuilding data
- Collaboration or multi-user mode (future exploration)
- User-defined templates for chapters and lore element types
- Simple analytics (word count history, progress charts)
- Optional “focus mode” writing environment

---

## Technical Notes
- Stack: Electron (main process + renderer), Node.js, HTML, CSS, plain JavaScript.
- Data Model: Single JSON file per project (`data/project.json`) with UI state persisted alongside entries.
- Workspace Model: Edits occur in an isolated workspace (under Electron `userData`); “Save Back” syncs to the project directory in Documents.
- Autosave: Idle-based with a failsafe timer and save-on-visibility-change.

---

## Author
Caleb Sessoms  
Developed as part of the CS399 Independent Project (Computer Science A.S. Program)  
GitHub: https://github.com/CalebSessoms/ink-doodle
