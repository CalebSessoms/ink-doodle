const fs = require('fs');
const path = require('path');

// Convert legacy project format to new format if needed
function migrateProjectData(data) {
    if (!data) return null;

    // Already in new format
    if (data.project && data.entries) {
        return data;
    }

    // Convert from legacy format
    const migrated = {
        project: {
            name: data.project?.title || 'Untitled Project',
            title: data.project?.title || 'Untitled Project',
            code: data.project?.code || `PRJ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            created_at: data.saved_at || new Date().toISOString(),
            updated_at: data.saved_at || new Date().toISOString(),
            saved_at: data.saved_at || new Date().toISOString(),
            creator_id: data.project?.creator_id || 1
        },
        entries: [],
        ui: {
            ...(data.ui || {}),
            mode: "theme",
            theme: "slate",
            bg: "aurora",
            bgOpacity: 0.2,
            bgBlur: 2,
            editorDim: false
        },
        version: data.version || 1
    };

    // Convert entries format
    if (Array.isArray(data.entries)) {
        dbg(`[project:migrate] Processing ${data.entries.length} entries`);
        
        // Map each entry through our DB mapping function
        migrated.entries = data.entries.map(entry => {
            const mapped = mapDbEntry(entry);
            dbg(`[project:migrate] Mapped entry ${mapped.id} (${mapped.type})`);
            return mapped;
        });
        
        dbg(`[project:migrate] Successfully mapped ${migrated.entries.length} entries`);
    }
    
    // Legacy format support
    else if (data.chapters?.added) {
        migrated.entries.push(
            ...data.chapters.added.map(ch => ({
                type: 'chapter',
                id: ch.id || `ch-${Math.random().toString(36).slice(2, 8)}`,
                title: ch.title || 'Untitled Chapter',
                status: ch.status || 'draft',
                tags: ch.tags || [],
                synopsis: ch.synopsis || '',
                body: ch.body || '',
                order_index: ch.order_index || 0,
                updated_at: ch.updated_at || data.saved_at || new Date().toISOString()
            }))
        );
    }

    if (data.notes?.added) {
        migrated.entries.push(
            ...data.notes.added.map(n => ({
                type: 'note',
                id: n.id || `note-${Math.random().toString(36).slice(2, 8)}`,
                title: n.title || 'Untitled Note',
                body: n.body || '',
                category: n.category || '',
                pinned: n.pinned || false,
                order_index: n.order_index || 0,
                updated_at: n.updated_at || data.saved_at || new Date().toISOString()
            }))
        );
    }

    if (data.refs?.added) {
        migrated.entries.push(
            ...data.refs.added.map(r => ({
                type: 'reference',
                id: r.id || `ref-${Math.random().toString(36).slice(2, 8)}`,
                title: r.title || 'Untitled Reference',
                refType: r.refType || '',
                sourceLink: r.sourceLink || '',
                body: r.body || '',
                order_index: r.order_index || 0,
                updated_at: r.updated_at || data.saved_at || new Date().toISOString()
            }))
        );
    }

    return migrated;
}

// Validate project data structure
// Detect entry type from ID or code
function detectEntryType(entry) {
    // First check explicit type if available
    if (entry.type && ['chapter', 'note', 'reference'].includes(entry.type)) {
        return entry.type;
    }
    
    // Then try to detect from ID
    const id = entry.id || entry.code;
    if (id) {
        if (id.startsWith('CHP-')) return 'chapter';
        if (id.startsWith('NT-')) return 'note';
        if (id.startsWith('RF-')) return 'reference';
        
        // Legacy format detection
        if (id.startsWith('chapter-')) return 'chapter';
        if (id.startsWith('note-')) return 'note';
        if (id.startsWith('reference-')) return 'reference';
    }
    
    debugLog(`[project:detect] Could not detect type for entry: ${JSON.stringify(entry)}`);
    return 'unknown';
}

// Map DB entry to app format
function mapDbEntry(entry) {
    const type = detectEntryType(entry);
    debugLog(`[project:map] Mapping entry ${entry.id || entry.code} (${type})`);
    
    const mapped = {
        // Prefer DB code over local ID
        id: entry.code || entry.id,
        type,
        title: entry.title || '(Untitled)',
        tags: Array.isArray(entry.tags) ? entry.tags : [],
        // Prefer number for DB entries, order_index for local
        order_index: entry.code ? (entry.number || 0) : (entry.order_index || 0),
        updated_at: entry.updated_at || new Date().toISOString(),
        created_at: entry.created_at || new Date().toISOString(),
        project_code: entry.project_code || entry.code?.split('-')?.[1]
    };
    
    debugLog(`[project:map] Mapped fields: ${JSON.stringify({
        id: mapped.id,
        type: mapped.type,
        title: mapped.title
    })}`);

    // Add type-specific fields
    if (type === 'chapter') {
        mapped.status = (entry.status || 'draft').toLowerCase();
        mapped.synopsis = entry.summary || '';
        mapped.body = entry.content || entry.body || '';
        mapped.word_goal = entry.word_goal || 0;
    } else if (type === 'note') {
        mapped.category = entry.category || 'Misc';
        mapped.pinned = !!entry.pinned;
        mapped.body = entry.content || entry.body || '';
    } else if (type === 'reference') {
        mapped.reference_type = entry.reference_type || 'Glossary';
        mapped.summary = entry.summary || '';
        mapped.source_link = entry.source_link || '';
        mapped.body = entry.content || entry.body || '';
    }

    return mapped;
}

function validateProjectData(data) {
    dbg(`[project:validate] Starting validation...`);
    
    if (!data || typeof data !== 'object') {
        console.error(`[project:validate] Data is not an object:`, data);
        throw new Error('Invalid project data: must be an object');
    }

    if (!data.project || typeof data.project !== 'object') {
        console.error(`[project:validate] Missing or invalid project object:`, data.project);
        throw new Error('Invalid project data: missing project object');
    }

    // Log project object structure
    console.log(`[project:validate] Project object:`, {
        name: data.project.name,
        title: data.project.title,
        code: data.project.code,
        hasCreatedAt: !!data.project.created_at,
        hasUpdatedAt: !!data.project.updated_at,
        hasSavedAt: !!data.project.saved_at
    });

    const required = ['name', 'title', 'code', 'created_at', 'updated_at', 'saved_at'];
    const missing = required.filter(key => !data.project[key]);
    if (missing.length) {
        console.error(`[project:validate] Missing required project fields:`, missing);
        throw new Error(`Invalid project data: missing required fields in project object: ${missing.join(', ')}`);
    }

    if (!Array.isArray(data.entries)) {
        dbg(`[project:validate] Entries is not an array:`, data.entries);
        throw new Error('Invalid project data: entries must be an array');
    }

    // Validate each entry has required fields
    data.entries.forEach((entry, idx) => {
        if (!entry.id && !entry.code) {
            dbg(`[project:validate] Entry ${idx} missing both ID and code`);
            throw new Error(`Entry ${idx} missing both id and code fields`);
        }
        if (!entry.type || !['chapter', 'note', 'reference'].includes(entry.type)) {
            dbg(`[project:validate] Entry ${entry.id} has invalid type: ${entry.type}`);
            throw new Error(`Entry ${entry.id} has invalid type: ${entry.type}`);
        }
    });

    // Log entries summary
    console.log(`[project:validate] Entries summary:`, {
        total: data.entries.length,
        types: data.entries.reduce((acc, e) => {
            acc[e.type] = (acc[e.type] || 0) + 1;
            return acc;
        }, {}),
        sampleEntry: data.entries[0] ? {
            type: data.entries[0].type,
            hasId: !!data.entries[0].id,
            hasTitle: !!data.entries[0].title
        } : null
    });

    if (!data.ui || typeof data.ui !== 'object') {
        console.error(`[project:validate] Missing or invalid UI object:`, data.ui);
        throw new Error('Invalid project data: missing ui object');
    }

    // Log UI object
    console.log(`[project:validate] UI object:`, {
        activeTab: data.ui.activeTab,
        hasSelectedId: !!data.ui.selectedId,
        hasCounters: !!data.ui.counters
    });

    console.log(`[project:validate] Validation successful`);
    return true;
}

// Safe read and parse of project file
const { ipcRenderer } = require('electron');

// Helper function to log through the main debug system
function debugLog(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log('[debug]', msg);
    if (typeof window !== 'undefined' && window.dbg) {
        window.dbg(msg);
    } else {
        ipcRenderer.invoke('debug:log', { message: msg }).catch(() => {});
    }
}

function readProjectFile(filePath) {
    try {
        debugLog(`project:load — Attempting to load project from ${filePath}`);
        
        // Try DB-synced path first
        const dir = path.dirname(path.dirname(filePath));
        const files = fs.readdirSync(dir);
        const dbSyncedDir = files.find(f => f.startsWith('PRJ-'));
        
        if (dbSyncedDir) {
            const dbSyncedPath = path.join(dir, dbSyncedDir, 'data', 'project.json');
            debugLog(`project:load — Found DB-synced path: ${dbSyncedPath}`);
            filePath = dbSyncedPath;
        }
        
        if (!fs.existsSync(filePath)) {
            debugLog(`project:load — Project file not found at ${filePath}`);
            throw new Error('Project file does not exist');
        }

        debugLog(`project:load — Reading project file from ${filePath}`);
        const content = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(content);
        
        console.log(`[project:load] Raw project data:`, {
            hasProject: !!data.project,
            entriesCount: Array.isArray(data.entries) ? data.entries.length : 0,
            hasLegacyFormat: !!(data.chapters?.added || data.notes?.added || data.refs?.added)
        });
        
        // Try to migrate if in legacy format
        console.log(`[project:load] Migrating project data...`);
        const migrated = migrateProjectData(data);
        if (!migrated) {
            console.error('[project:load] Migration failed - no data returned');
            throw new Error('Could not migrate project data');
        }

        console.log(`[project:load] Migration complete:`, {
            project: {
                title: migrated.project?.title,
                code: migrated.project?.code
            },
            entriesCount: migrated.entries?.length || 0,
            entriesByType: migrated.entries?.reduce((acc, e) => {
                acc[e.type] = (acc[e.type] || 0) + 1;
                return acc;
            }, {})
        });

        // Validate the structure
        console.log(`[project:load] Validating project structure...`);
        validateProjectData(migrated);
        console.log(`[project:load] Validation successful`);
        
        return migrated;
    } catch (error) {
        throw new Error(`Failed to read project file: ${error.message}`);
    }
}

module.exports = {
    migrateProjectData,
    validateProjectData,
    readProjectFile
};