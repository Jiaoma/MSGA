/**
 * MSGA Session Persistence - Save/restore sessions for continuity
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SESSIONS_DIR = join(process.env.HOME || '~', '.msga', 'sessions');

export interface SessionSnapshot {
  id: string;
  createdAt: string;
  updatedAt: string;
  workingDir: string;
  task: string;
  messages: Array<{ role: string; content: string }>;
  filesModified: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Save a session snapshot to disk
 */
export function saveSession(snapshot: SessionSnapshot): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  snapshot.updatedAt = new Date().toISOString();
  const filePath = join(SESSIONS_DIR, `${snapshot.id}.json`);
  writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
}

/**
 * Load a session snapshot
 */
export function loadSession(id: string): SessionSnapshot | null {
  const filePath = join(SESSIONS_DIR, `${id}.json`);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

/**
 * List all saved sessions (most recent first)
 */
export function listSessions(limit = 20): Array<{ id: string; task: string; updatedAt: string; workingDir: string }> {
  if (!existsSync(SESSIONS_DIR)) return [];

  const files = readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const fullPath = join(SESSIONS_DIR, f);
      const stat = statSync(fullPath);
      return { file: f, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);

  return files.map(({ file }) => {
    try {
      const data = JSON.parse(readFileSync(join(SESSIONS_DIR, file), 'utf-8'));
      return {
        id: data.id || file.replace('.json', ''),
        task: data.task?.slice(0, 80) || '(untitled)',
        updatedAt: data.updatedAt || '',
        workingDir: data.workingDir || '',
      };
    } catch {
      return { id: file.replace('.json', ''), task: '(corrupted)', updatedAt: '', workingDir: '' };
    }
  });
}

/**
 * Delete a session
 */
export function deleteSession(id: string): boolean {
  const filePath = join(SESSIONS_DIR, `${id}.json`);
  if (!existsSync(filePath)) return false;
  execSync(`trash "${filePath}" 2>/dev/null || rm "${filePath}"`);
  return true;
}

/**
 * Generate a unique session ID
 */
export function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 6);
  return `sess-${timestamp}-${random}`;
}
