import { Pool } from 'pg';
import { withTransaction, handleDatabaseError } from './db.utils';
import { DatabaseError } from './db.errors';
import type { Chapter, Note, Reference } from './types/db.types';

export interface BatchResult<T> {
    success: T[];
    failures: Array<{
        item: T;
        error: Error;
    }>;
}

export async function batchCreateChapters(
    pool: Pool,
    projectId: number,
    creatorId: number,
    chapters: Omit<Chapter, 'id' | 'code' | 'created_at' | 'updated_at'>[]
): Promise<BatchResult<Chapter>> {
    return withTransaction(pool, async (client) => {
        const result: BatchResult<Chapter> = {
            success: [],
            failures: []
        };

        for (const chapter of chapters) {
            try {
                const res = await client.query<Chapter>(
                    `INSERT INTO chapters (
                        project_id, creator_id, number, title, content,
                        status, summary, tags, word_goal
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    RETURNING *`,
                    [
                        projectId,
                        creatorId,
                        chapter.number,
                        chapter.title,
                        chapter.content,
                        chapter.status,
                        chapter.summary,
                        chapter.tags,
                        chapter.word_goal
                    ]
                );
                result.success.push(res.rows[0]);
            } catch (error) {
                result.failures.push({
                    item: chapter as Chapter,
                    error: error instanceof Error ? error : new Error(String(error))
                });
            }
        }

        return result;
    });
}

export async function batchCreateNotes(
    pool: Pool,
    projectId: number,
    creatorId: number,
    notes: Omit<Note, 'id' | 'code' | 'created_at' | 'updated_at'>[]
): Promise<BatchResult<Note>> {
    return withTransaction(pool, async (client) => {
        const result: BatchResult<Note> = {
            success: [],
            failures: []
        };

        for (const note of notes) {
            try {
                const res = await client.query<Note>(
                    `INSERT INTO notes (
                        project_id, creator_id, number, title, content,
                        tags, category, pinned
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    RETURNING *`,
                    [
                        projectId,
                        creatorId,
                        note.number,
                        note.title,
                        note.content,
                        note.tags,
                        note.category,
                        note.pinned
                    ]
                );
                result.success.push(res.rows[0]);
            } catch (error) {
                result.failures.push({
                    item: note as Note,
                    error: error instanceof Error ? error : new Error(String(error))
                });
            }
        }

        return result;
    });
}

export async function batchCreateReferences(
    pool: Pool,
    projectId: number,
    creatorId: number,
    refs: Omit<Reference, 'id' | 'code' | 'created_at' | 'updated_at'>[]
): Promise<BatchResult<Reference>> {
    return withTransaction(pool, async (client) => {
        const result: BatchResult<Reference> = {
            success: [],
            failures: []
        };

        for (const ref of refs) {
            try {
                const res = await client.query<Reference>(
                    `INSERT INTO refs (
                        project_id, creator_id, number, title, tags,
                        reference_type, summary, source_link, content
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    RETURNING *`,
                    [
                        projectId,
                        creatorId,
                        ref.number,
                        ref.title,
                        ref.tags,
                        ref.reference_type,
                        ref.summary,
                        ref.source_link,
                        ref.content
                    ]
                );
                result.success.push(res.rows[0]);
            } catch (error) {
                result.failures.push({
                    item: ref as Reference,
                    error: error instanceof Error ? error : new Error(String(error))
                });
            }
        }

        return result;
    });
}

// Batch reorder items within a project
export async function batchReorderItems(
    pool: Pool,
    type: 'chapter' | 'note' | 'reference',
    items: Array<{ code: string; number: number }>
): Promise<void> {
    const table = type === 'chapter' ? 'chapters' 
                 : type === 'note' ? 'notes' 
                 : 'refs';

    return withTransaction(pool, async (client) => {
        try {
            for (const item of items) {
                await client.query(
                    `UPDATE ${table} SET number = $1 WHERE code = $2`,
                    [item.number, item.code]
                );
            }
        } catch (error) {
            throw handleDatabaseError(error);
        }
    });
}