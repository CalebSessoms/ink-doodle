// Upload/change-tracking interfaces removed
// Note: EntityChanges and ProjectChanges were removed because local->DB
// upload flows were intentionally deleted. Reintroduce these only if you
// re-enable upload/change-tracking behavior.

// Base interface for all entities with codes
export interface CodedEntity {
    id: number;
    code: string;
    created_at: string;
    updated_at: string;
}

export interface Project extends CodedEntity {
    title: string;
    creator_id: number;
    chapters: Chapter[];
    notes: Note[];
    refs: Reference[];
}

export interface Chapter extends CodedEntity {
    project_id: number;
    creator_id: number;
    number: number | null;
    title: string;
    content: string | null;
    status: string;
    summary: string | null;
    tags: string[];
    word_goal: number;
}

export interface Note extends CodedEntity {
    project_id: number;
    creator_id: number;
    number: number | null;
    title: string;
    content: string | null;
    tags: string[];
    category: string | null;
    pinned: boolean;
}

export interface Reference extends CodedEntity {
    project_id: number;
    creator_id: number;
    number: number | null;
    title: string;
    tags: string[];
    type: string | null;
    summary: string | null;
    link: string | null;
    content: string | null;
}