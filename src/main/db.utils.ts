import { Pool, PoolClient } from 'pg';
import { DatabaseError, ValidationError, NotFoundError, DuplicateError, PG_ERROR_CODES } from './db.errors';
import type { Project, Chapter, Note, Reference } from './db.types';

// Validation functions
export function validateProject(project: Partial<Project>): void {
    if (!project.title?.trim()) {
        throw new ValidationError('Project title is required');
    }
    if (!project.creator_id) {
        throw new ValidationError('Creator ID is required');
    }
}

export function validateChapter(chapter: Partial<Chapter>): void {
    if (!chapter.title?.trim()) {
        throw new ValidationError('Chapter title is required');
    }
    if (!chapter.project_id) {
        throw new ValidationError('Project ID is required');
    }
    if (!chapter.creator_id) {
        throw new ValidationError('Creator ID is required');
    }
    if (chapter.word_goal !== undefined && chapter.word_goal < 0) {
        throw new ValidationError('Word goal must be non-negative');
    }
}

export function validateNote(note: Partial<Note>): void {
    if (!note.title?.trim()) {
        throw new ValidationError('Note title is required');
    }
    if (!note.project_id) {
        throw new ValidationError('Project ID is required');
    }
    if (!note.creator_id) {
        throw new ValidationError('Creator ID is required');
    }
}

export function validateReference(ref: Partial<Reference>): void {
    if (!ref.title?.trim()) {
        throw new ValidationError('Reference title is required');
    }
    if (!ref.project_id) {
        throw new ValidationError('Project ID is required');
    }
    if (!ref.creator_id) {
        throw new ValidationError('Creator ID is required');
    }
}

// Helper for running operations in a transaction
export async function withTransaction<T>(
    pool: Pool,
    operation: (client: PoolClient) => Promise<T>
): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

// Helper for handling database errors
export function handleDatabaseError(error: any): never {
    if (error.code === PG_ERROR_CODES.UNIQUE_VIOLATION) {
        throw new DuplicateError(error.detail || 'Item already exists');
    }
    if (error.code === PG_ERROR_CODES.FOREIGN_KEY_VIOLATION) {
        throw new ValidationError(error.detail || 'Referenced item does not exist');
    }
    if (error.code === PG_ERROR_CODES.NOT_NULL_VIOLATION) {
        throw new ValidationError(error.detail || 'Required field is missing');
    }
    throw new DatabaseError(error.message || 'Database operation failed', error);
}