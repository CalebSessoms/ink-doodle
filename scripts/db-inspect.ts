import path from 'path';
import { loadProjectForUpload, getLastLoadedProject, getLastLoadedCreator, getLastLoadedChapterCols, getLastLoadedNoteCols, getLastLoadedRefCols, chapterColsToRows, noteColsToRows, refColsToRows } from '../src/main/db.format';
import { getColumnValue, getFirstRow } from '../src/main/db.query';

(async function main() {
  const projectPath = path.join(__dirname, '..', 'FormatInfo', 'localFormatShowcase');
  console.log('Loading local project from:', projectPath);

  try {
    await loadProjectForUpload(projectPath);
    const proj = getLastLoadedProject();
    const creator = getLastLoadedCreator();

    console.log('Project:', proj);
    console.log('Creator:', creator);

    // Print collection summaries from the formatter getters
    const chCols = getLastLoadedChapterCols();
    const noCols = getLastLoadedNoteCols();
    const rfCols = getLastLoadedRefCols();
    console.log('chapter_cols keys:', chCols ? Object.keys(chCols) : '<none>');
    console.log('note_cols keys:', noCols ? Object.keys(noCols) : '<none>');
    console.log('ref_cols keys:', rfCols ? Object.keys(rfCols) : '<none>');

  // Convert column collections to rows (viewable form) and print the first row
  const chRows = chapterColsToRows();
  const noRows = noteColsToRows();
  const rfRows = refColsToRows();
  console.log('\nEntry ID counts: chapters=', chRows.length, 'notes=', noRows.length, 'refs=', rfRows.length);
  console.log('\nFirst chapter row:', chRows.length ? chRows[0] : '<none>');
  console.log('First note row:', noRows.length ? noRows[0] : '<none>');
  console.log('First ref row:', rfRows.length ? rfRows[0] : '<none>');

    console.log('\n--- DB checks (read-only) ---');
    // creators table should have at least one entry in your test DB
    try {
      const email = await getColumnValue('creators', 'email');
      console.log('creators.email (first row):', email);
    } catch (err: any) {
      console.error('getColumnValue failed:', err?.message || err);
    }

    try {
      const first = await getFirstRow('creators');
      console.log('creators.firstRow:', first);
    } catch (err: any) {
      console.error('getFirstRow failed:', err?.message || err);
    }

    process.exit(0);
  } catch (err: any) {
    console.error('Error loading project or running DB checks:', err?.message || err);
    process.exit(2);
  }
})();
