export interface Project {
  id: number;
  code: string;
  title: string;
  creator_id: number;
  created_at: string;
  updated_at: string;
  chapters: Chapter[];
  notes: Note[];
  refs: Reference[];
}

export interface Chapter {
  id: number;
  code: string;
  project_id: number;
  creator_id: number;
  number: number | null;
  title: string;
  content: string | null;
  status: string;
  summary: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  word_goal: number;
}

export interface Note {
  id: number;
  code: string;
  project_id: number;
  creator_id: number;
  number: number | null;
  title: string;
  content: string | null;
  tags: string[];
  category: string | null;
  pinned: boolean;
  created_at: string;
  updated_at: string;
}

export interface Reference {
  id: number;
  code: string;
  project_id: number;
  creator_id: number;
  number: number | null;
  title: string;
  tags: string[];
  reference_type: string | null;
  summary: string | null;
  source_link: string | null;
  content: string | null;
  created_at: string;
  updated_at: string;
}

// Interface for tracking changes
export interface EntityChanges<T> {
  added: T[];
  updated: T[];
  deleted: string[]; // Array of codes to delete
}

export interface ProjectChanges {
  project: Project;
  chapters: EntityChanges<Chapter>;
  notes: EntityChanges<Note>;
  refs: EntityChanges<Reference>;
}