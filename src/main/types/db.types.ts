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
  type: string | null;
  summary: string | null;
  link: string | null;
  content: string | null;
  created_at: string;
  updated_at: string;
}

// Interface for tracking changes
// Upload-related change-tracking types were removed because local->DB
// uploads have been intentionally removed from the application. If you
// later reintroduce upload flows, re-add appropriate change-tracking
// interfaces here.