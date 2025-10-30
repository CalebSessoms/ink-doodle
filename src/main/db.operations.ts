// db.operations.ts - Database operations
import { pool } from './db';
import { appendDebugLog } from './log';

export async function saveItem(type: string, data: any, creatorId: number) {
  try {
    // Debug log the incoming data
    appendDebugLog(`db:save:debug — Received ${type} data: ${JSON.stringify(data, null, 2)}`);
    
    let table = '';
    switch (type) {
      case 'chapter': table = 'chapters'; break;
      case 'note': table = 'notes'; break;
      case 'reference': table = 'refs'; break;
      default: throw new Error(`Invalid item type: ${type}`);
    }
    
    // Log the expected format based on type
    const expectedFormat = {
      chapter: ['title', 'content/body', 'status', 'summary/synopsis', 'tags', 'number/order_index', 'word_goal', 'project_id'],
      note: ['title', 'content/body', 'tags', 'category', 'pinned', 'number/order_index', 'project_id'],
      reference: ['title', 'content/body', 'tags', 'type/reference_type', 'summary', 'link/source_link', 'number/order_index', 'project_id']
    };
    appendDebugLog(`db:save:debug — Expected fields for ${type}: ${JSON.stringify(expectedFormat[type as keyof typeof expectedFormat])}`);
    appendDebugLog(`db:save:debug — Missing required fields: ${expectedFormat[type as keyof typeof expectedFormat]
      .filter(field => {
        const [primary, alternate] = field.split('/');
        return !data[primary] && (!alternate || !data[alternate]);
      })
      .join(', ')}`);
    
    // Build query based on table and operation type
    let query = '';
    let params = [];

    if (data.code) {
      // First check if item exists
      const checkQuery = `SELECT id FROM ${table} WHERE code = $1 AND creator_id = $2`;
      const checkResult = await pool.query(checkQuery, [data.code, data.creator_id || creatorId]);
      
      if (checkResult.rows.length === 0) {
        // Item doesn't exist, do INSERT instead
        appendDebugLog(`db:save:debug — Item ${data.code} not found, switching to INSERT`);
        data.code = undefined; // Force INSERT path
      }
    }

    if (data.code) {
      // UPDATE existing item
      switch (table) {
        case 'chapters':
          query = `
            UPDATE chapters 
            SET title = $1, content = $2, status = $3, summary = $4,
                tags = $5, number = $6, word_goal = $7, updated_at = NOW()
            WHERE code = $8 AND creator_id = $9
            RETURNING *
          `;
          // Construct params array with all parameters in correct order
          params = [
            data.title,
            data.content || data.body || '',
            data.status || 'draft',
            data.summary || data.synopsis || '',
            data.tags || [],
            data.number ?? data.order_index ?? 0,
            data.word_goal || 0,
            data.code || data.id,
            data.creator_id || creatorId
          ];
          break;

        case 'notes':
          query = `
            UPDATE notes 
            SET title = $1, content = $2, tags = $3, category = $4,
                pinned = $5, number = $6, updated_at = NOW()
            WHERE code = $7 AND creator_id = $8
            RETURNING *
          `;
          params = [
            data.title,
            data.content || '',
            data.tags || [],
            data.category || 'Misc',
            data.pinned || false,
            data.number || 0,
            data.code,
            creatorId
          ];
          break;

        case 'refs':
          query = `
            UPDATE refs 
            SET title = $1, content = $2, tags = $3, reference_type = $4,
                summary = $5, source_link = $6, number = $7, updated_at = NOW()
            WHERE code = $8 AND creator_id = $9
            RETURNING *
          `;
          params = [
            data.title,
            data.content || '',
            data.tags || [],
            data.reference_type || 'Glossary',
            data.summary || '',
            data.source_link || '',
            data.number || 0,
            data.code,
            creatorId
          ];
          break;
      }
    } else {
      // INSERT
      switch (table) {
        case 'chapters':
          query = `
            INSERT INTO chapters 
            (project_id, creator_id, title, content, status, summary,
             tags, number, word_goal)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *
          `;
          // Construct params array with all parameters in correct order
          params = [
            data.project_id,
            data.creator_id || creatorId,
            data.title,
            data.content || data.body || '',
            data.status || 'draft',
            data.summary || data.synopsis || '',
            data.tags || [],
            data.number ?? data.order_index ?? 0,
            data.word_goal || 0
          ];
          break;

        case 'notes':
          query = `
            INSERT INTO notes 
            (project_id, creator_id, title, content, tags,
             category, pinned, number)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
          `;
          params = [
            data.project_id,
            creatorId,
            data.title,
            data.content || '',
            data.tags || [],
            data.category || 'Misc',
            data.pinned || false,
            data.number || 0
          ];
          break;

        case 'refs':
          query = `
            INSERT INTO refs 
            (project_id, creator_id, title, content, tags,
             reference_type, summary, source_link, number)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *
          `;
          params = [
            data.project_id,
            creatorId,
            data.title,
            data.content || '',
            data.tags || [],
            data.reference_type || 'Glossary',
            data.summary || '',
            data.source_link || '',
            data.number || 0
          ];
          break;
      }
    }
      
    // Debug log the SQL query
    appendDebugLog(`db:save:debug — SQL Query:\n${query}`);
    
    // Debug log the parameters with their positions
    const paramDebug = params.map((value, index) => 
      `$${index + 1}: ${typeof value === 'object' ? JSON.stringify(value) : value}`
    );
    appendDebugLog(`db:save:debug — Query parameters:\n${paramDebug.join('\n')}`);
    
    // Pre-validate required fields with detailed output
    const requiredFields = {
      chapter: ['title', 'project_id'],
      note: ['title', 'project_id'],
      reference: ['title', 'project_id']
    };
    
    // Debug log all field values
    Object.keys(data).forEach(key => {
      const value = data[key];
      appendDebugLog(`db:save:debug — Field ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
    });
    
    const missing = requiredFields[type]?.filter(field => {
      // Handle field alternatives (e.g. 'content/body')
      if (field.includes('/')) {
        const [primary, alternate] = field.split('/');
        const hasPrimary = data[primary] !== undefined;
        const hasAlternate = data[alternate] !== undefined;
        appendDebugLog(`db:save:debug — Checking field ${primary}/${alternate}: primary=${hasPrimary}, alternate=${hasAlternate}`);
        return !hasPrimary && !hasAlternate;
      }
      // Special handling for number fields - 0 is a valid value
      if (field === 'number' || field === 'order_index') {
        const hasField = data[field] !== undefined && data[field] !== null;
        appendDebugLog(`db:save:debug — Checking number field ${field}: ${hasField}`);
        return !hasField;
      }
      const hasField = data[field] !== undefined;
      appendDebugLog(`db:save:debug — Checking field ${field}: ${hasField}`);
      return !hasField;
    });
    
    if (missing && missing.length > 0) {
      appendDebugLog(`db:save:error — Missing required fields for ${type}: ${missing.join(', ')}`);
      throw new Error(`Missing required fields for ${type}: ${missing.join(', ')}`);
    }

    // Log the final state before executing query
    appendDebugLog(`db:save:debug — Executing ${data.code ? 'UPDATE' : 'INSERT'} for ${type} with ${params.length} parameters`);
    
    let result;
    try {
      result = await pool.query(query, params);
      
      if (!result.rows[0]) {
        const queryInfo = {
          table: table,
          params: params,
          operation: data.code ? 'UPDATE' : 'INSERT',
          query: query
        };
        appendDebugLog(`db:save:error — Query returned no rows for ${type}. Query details: ${JSON.stringify(queryInfo, null, 2)}`);
        throw new Error(`Failed to save ${type}`);
      }
    } catch (queryError) {
      // Enhanced error logging for query execution
      appendDebugLog(`db:save:error — Database error details:`);
      appendDebugLog(`- Error: ${queryError.message}`);
      appendDebugLog(`- Table: ${table}`);
      appendDebugLog(`- Operation: ${data.code ? 'UPDATE' : 'INSERT'}`);
      appendDebugLog(`- Parameters count: ${params.length}`);
      appendDebugLog(`- Query:\n${query}`);
      appendDebugLog(`- Parameters:\n${params.map((p, i) => `  $${i+1}: ${JSON.stringify(p)}`).join('\n')}`);
      throw queryError;
    }
    
    appendDebugLog(`db:save:success — Saved ${type} ${data.code || 'new'}: ${JSON.stringify(result.rows[0], null, 2)}`);
    return result.rows[0];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendDebugLog(`db:save:error — Error saving ${type}: ${msg}`);
    if (err instanceof Error && err.stack) {
      appendDebugLog(`db:save:error — Stack trace: ${err.stack}`);
    }
    throw err;
  }
}

export async function deleteItem(type: string, code: string) {
  try {
    let table = '';
    switch (type) {
      case 'chapter': table = 'chapters'; break;
      case 'note': table = 'notes'; break;
      case 'reference': table = 'refs'; break;
      default: throw new Error(`Invalid item type: ${type}`);
    }
    
    const query = `DELETE FROM ${table} WHERE code = $1`;
    await pool.query(query, [code]);
    
    appendDebugLog(`db:delete — Deleted ${type} ${code}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendDebugLog(`db:delete — Error deleting ${type}: ${msg}`);
    throw err;
  }
}