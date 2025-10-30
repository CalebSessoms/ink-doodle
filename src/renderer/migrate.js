const fs = require('fs');
const path = require('path');

function migrateProjectJson(filePath) {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    
    // Create new structure
    const migrated = {
        project: {
            name: data.project.title,
            title: data.project.title,
            code: `PRJ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            created_at: data.saved_at || new Date().toISOString(),
            updated_at: data.saved_at || new Date().toISOString(),
            saved_at: data.saved_at || new Date().toISOString()
        },
        entries: [], // Convert chapters/notes/refs to entries if they exist
        ui: {
            activeTab: data.ui?.activeTab || "chapters",
            selectedId: data.ui?.selectedId || null,
            counters: data.ui?.counters || {
                chapter: 1,
                note: 1,
                reference: 1
            },
            mode: "theme",
            theme: "slate",
            bg: "aurora",
            bgOpacity: 0.2,
            bgBlur: 2,
            editorDim: false
        },
        version: data.version || 1
    };

    // Convert legacy format to entries array if needed
    if (data.chapters) {
        // Handle chapters
        if (Array.isArray(data.chapters.added)) {
            migrated.entries.push(...data.chapters.added.map(ch => ({
                type: 'chapter',
                ...ch
            })));
        }
        // Similar for notes and refs if needed
    }

    // Write back the migrated data
    fs.writeFileSync(filePath, JSON.stringify(migrated, null, 2));
    console.log(`Migrated ${filePath}`);
    return migrated;
}

// Usage example:
function migrateAllProjects(rootDir) {
    const projects = fs.readdirSync(rootDir);
    
    projects.forEach(proj => {
        const projectJsonPath = path.join(rootDir, proj, 'data', 'project.json');
        if (fs.existsSync(projectJsonPath)) {
            try {
                migrateProjectJson(projectJsonPath);
                console.log(`Successfully migrated ${proj}`);
            } catch (error) {
                console.error(`Failed to migrate ${proj}:`, error);
            }
        }
    });
}

// Export for use in main app
module.exports = { migrateProjectJson, migrateAllProjects };