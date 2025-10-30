// db.format.ts - Format transformation utilities
import { Project, Chapter, Note, Reference } from './types/db.types';
import * as fs from 'fs';
import * as path from 'path';

// Local Format Types
export interface LocalProject {
  title: string;
  name: string;
  code?: string;
  creator_id?: number;
  saved_at: string;
  created_at?: string;
  updated_at: string;
}

export interface LocalUIState {
  activeTab: string;
  selectedId: string | null;
  counters: {
    chapter: number;
    note: number;
    reference: number;
  };
  mode?: string;
  theme?: string;
  bg?: string;
  bgOpacity?: number;
  bgBlur?: number;
  editorDim?: boolean;
}

export interface LocalEntryBase {
  id: string;
  type: 'chapter' | 'note' | 'reference';
  title: string;
  updated_at: string;
  created_at: string;
  order_index: number;
  body: string;
  tags: string[];
}

export interface LocalChapter extends LocalEntryBase {
  type: 'chapter';
  status: string;
  synopsis: string;
  word_goal: number;
}

export interface LocalNote extends LocalEntryBase {
  type: 'note';
  category: string;
  pinned: boolean;
}

export interface LocalReference extends LocalEntryBase {
  type: 'reference';
  reference_type: string;
  summary: string;
  source_link: string;
}

export type LocalEntry = LocalChapter | LocalNote | LocalReference;

export interface LocalProjectData {
  project: LocalProject;
  entries: LocalEntry[];
  ui: LocalUIState;
  version: number;
}

// Helper Functions
function generateLocalId(type: string, timestamp?: string): string {
  const ts = timestamp ? new Date(timestamp).getTime() : Date.now();
  const rand = Math.random().toString(36).slice(2, 10);
  return `${type}-${ts}-${rand}`;
}

function sanitizeDirectoryName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').trim();
}

// DB to Local Format Transformations
export function dbToLocalProject(dbProject: Project): LocalProject {
  return {
    title: dbProject.title,
    name: dbProject.title,
    code: dbProject.code,
    creator_id: dbProject.creator_id,
    saved_at: new Date().toISOString(),
    created_at: dbProject.created_at,
    updated_at: dbProject.updated_at
  };
}

export function dbToLocalChapter(dbChapter: Chapter): LocalChapter {
  return {
    id: dbChapter.code || generateLocalId('chapter', dbChapter.created_at),
    type: 'chapter',
    title: dbChapter.title || '',
    status: dbChapter.status || 'Draft',
    synopsis: dbChapter.summary || '',
    body: dbChapter.content || '',
    word_goal: typeof dbChapter.word_goal === 'number' ? dbChapter.word_goal : 0,
    order_index: typeof dbChapter.number === 'number' ? dbChapter.number : 0,
    tags: Array.isArray(dbChapter.tags) ? dbChapter.tags : [],
    created_at: dbChapter.created_at || new Date().toISOString(),
    updated_at: dbChapter.updated_at || new Date().toISOString()
  };
}

export function dbToLocalNote(dbNote: Note): LocalNote {
  return {
    id: dbNote.code || generateLocalId('note', dbNote.created_at),
    type: 'note',
    title: dbNote.title || '',
    category: dbNote.category || 'Misc',
    pinned: !!dbNote.pinned,
    body: dbNote.content || '',
    order_index: typeof dbNote.number === 'number' ? dbNote.number : 0,
    tags: Array.isArray(dbNote.tags) ? dbNote.tags : [],
    created_at: dbNote.created_at || new Date().toISOString(),
    updated_at: dbNote.updated_at || new Date().toISOString()
  };
}

export function dbToLocalReference(dbRef: Reference): LocalReference {
  return {
    id: dbRef.code || generateLocalId('reference', dbRef.created_at),
    type: 'reference',
    title: dbRef.title || '',
    reference_type: dbRef.reference_type || 'Glossary',
    summary: dbRef.summary || '',
    source_link: dbRef.source_link || '',
    body: dbRef.content || '',
    order_index: typeof dbRef.number === 'number' ? dbRef.number : 0,
    tags: Array.isArray(dbRef.tags) ? dbRef.tags : [],
    created_at: dbRef.created_at || new Date().toISOString(),
    updated_at: dbRef.updated_at || new Date().toISOString()
  };
}

// Local to DB Format Transformations
export function localToDbProject(localProject: LocalProject): Partial<Project> {
  return {
    title: localProject.title,
    code: localProject.code,
    creator_id: localProject.creator_id,
    created_at: localProject.created_at,
    updated_at: localProject.updated_at
  };
}

export function localToDbChapter(localChapter: LocalChapter & { project_id?: number, creator_id?: number }): Partial<Chapter> {
  return {
    title: localChapter.title || '',
    content: localChapter.body || '',
    status: localChapter.status || 'Draft',
    summary: localChapter.synopsis || '',
    tags: Array.isArray(localChapter.tags) ? localChapter.tags : [],
    number: typeof localChapter.order_index === 'number' ? localChapter.order_index : 0,
    word_goal: typeof localChapter.word_goal === 'number' ? localChapter.word_goal : 0,
    created_at: localChapter.created_at || new Date().toISOString(),
    updated_at: localChapter.updated_at || new Date().toISOString(),
    code: localChapter.id || '',
    project_id: localChapter.project_id,
    creator_id: localChapter.creator_id
  };
}

export function localToDbNote(localNote: LocalNote & { project_id?: number, creator_id?: number }): Partial<Note> {
  return {
    title: localNote.title || '',
    content: localNote.body || '',
    tags: Array.isArray(localNote.tags) ? localNote.tags : [],
    category: localNote.category || 'Misc',
    pinned: !!localNote.pinned,
    number: typeof localNote.order_index === 'number' ? localNote.order_index : 0,
    created_at: localNote.created_at || new Date().toISOString(),
    updated_at: localNote.updated_at || new Date().toISOString(),
    code: localNote.id || '',
    project_id: localNote.project_id,
    creator_id: localNote.creator_id
  };
}

export function localToDbReference(localRef: LocalReference & { project_id?: number, creator_id?: number }): Partial<Reference> {
  return {
    title: localRef.title || '',
    content: localRef.body || '',
    tags: Array.isArray(localRef.tags) ? localRef.tags : [],
    reference_type: localRef.reference_type || 'Glossary',
    summary: localRef.summary || '',
    source_link: localRef.source_link || '',
    number: typeof localRef.order_index === 'number' ? localRef.order_index : 0,
    created_at: localRef.created_at || new Date().toISOString(),
    updated_at: localRef.updated_at || new Date().toISOString(),
    code: localRef.id || '',
    project_id: localRef.project_id,
    creator_id: localRef.creator_id
  };
}

// Generic transform functions that handle all types
export function dbToLocal(data: any, type: 'project' | 'chapter' | 'note' | 'reference'): any {
  switch (type) {
    case 'project':
      return dbToLocalProject(data);
    case 'chapter':
      return dbToLocalChapter(data);
    case 'note':
      return dbToLocalNote(data);
    case 'reference':
      return dbToLocalReference(data);
  }
}

export function localToDb(data: any, type: 'project' | 'chapter' | 'note' | 'reference'): any {
  switch (type) {
    case 'project':
      return localToDbProject(data);
    case 'chapter':
      return localToDbChapter(data as LocalChapter);
    case 'note':
      return localToDbNote(data as LocalNote);
    case 'reference':
      return localToDbReference(data as LocalReference);
  }
}

// Validation functions
export function isValidLocalFormat(data: any, type: 'project' | 'chapter' | 'note' | 'reference'): boolean {
  try {
    switch (type) {
      case 'project':
        return (
          typeof data.title === 'string' &&
          typeof data.name === 'string' &&
          typeof data.updated_at === 'string'
        );
      case 'chapter':
        return (
          data.type === 'chapter' &&
          typeof data.title === 'string' &&
          typeof data.body === 'string' &&
          typeof data.status === 'string' &&
          Array.isArray(data.tags)
        );
      case 'note':
        return (
          data.type === 'note' &&
          typeof data.title === 'string' &&
          typeof data.body === 'string' &&
          typeof data.category === 'string' &&
          Array.isArray(data.tags)
        );
      case 'reference':
        return (
          data.type === 'reference' &&
          typeof data.title === 'string' &&
          typeof data.body === 'string' &&
          typeof data.reference_type === 'string' &&
          Array.isArray(data.tags)
        );
      default:
        return false;
    }
  } catch {
    return false;
  }
}

// Directory name utilities
export function getProjectDirectoryName(project: Project | LocalProject): string {
  return sanitizeDirectoryName(project.title);
}

export function findExistingProjectDirectory(projectCode: string, directories: string[], basePath: string): string | null {
  return directories.find(dir => {
    try {
      const projectFilePath = path.join(basePath, dir, 'data', 'project.json');
      if (!fs.existsSync(projectFilePath)) return false;
      const projectJson = JSON.parse(fs.readFileSync(projectFilePath, 'utf8'));
      return projectJson.project?.code === projectCode;
    } catch {
      return false;
    }
  }) || null;
}