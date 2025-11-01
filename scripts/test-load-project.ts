import path from 'path';
import { loadProjectForUpload, getLastLoadedProject, getLastLoadedCreator, getNextChapter, noteColsToRows, refColsToRows } from '../src/main/db.format';

(async function main() {
  const projectPath = path.join(__dirname, '..', 'FormatInfo', 'localFormatShowcase');
  console.log('Testing loadProjectForUpload with:', projectPath);

  try {
    const result = await loadProjectForUpload(projectPath);
    const proj = getLastLoadedProject();
    const creator = getLastLoadedCreator();

    // Print project/creator and then iterate chapters using getNextChapter()
    console.log('Project:', proj);
    console.log('Creator:', creator);

    console.log('\nChapters (iterating via getNextChapter):');
    let ch = getNextChapter();
    let idx = 0;
    while (ch) {
      console.log(`#${++idx}:`, JSON.stringify(ch, null, 2));
      ch = getNextChapter();
    }

    // Notes (snapshot via noteColsToRows)
    console.log('\nNotes (snapshot via noteColsToRows):');
    const notes = noteColsToRows();
    if (notes.length === 0) {
      console.log('  (no notes)');
    } else {
      for (let i = 0; i < notes.length; i++) {
        console.log(`#${i + 1}:`, JSON.stringify(notes[i], null, 2));
      }
    }

    // Refs (snapshot via refColsToRows)
    console.log('\nRefs (snapshot via refColsToRows):');
    const refs = refColsToRows();
    if (refs.length === 0) {
      console.log('  (no refs)');
    } else {
      for (let i = 0; i < refs.length; i++) {
        console.log(`#${i + 1}:`, JSON.stringify(refs[i], null, 2));
      }
    }

    // Exit cleanly
    process.exit(0);
  } catch (err: any) {
    console.error('Error running test:', err?.message || err);
    process.exit(2);
  }
})();
