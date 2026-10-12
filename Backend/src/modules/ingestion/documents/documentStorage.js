/**
 * @file documentStorage.js
 * @description Replaceable storage for original document bytes.
 *
 * Storage adapter interface (what the processing service depends on):
 *   put({ buffer, extension }) -> Promise<{ key: string, storageRef: { provider, key, url } }>
 *   delete(key)                -> Promise<boolean>   // true if a file was removed
 *   read(key)                  -> Promise<Buffer>
 *   name                       -> string             // adapter name, for diagnostics
 *
 * `storageRef` must fit the Document model's storageRef subdocument
 * ({ provider: 'vercel-blob' | 's3' | 'none', key, url }).
 *
 * LOCAL STORAGE LIMITATIONS: the only adapter here writes to the local filesystem.
 * That is NOT durable on Vercel (ephemeral /tmp per instance) or any multi-instance
 * deployment; files can disappear and are not shared between instances. It is
 * meant for local development, tests, and single-host deployments. The Document
 * schema anticipates 'vercel-blob' / 's3'; a production adapter implementing the
 * same interface can be dropped in without changing the processing service.
 * Because the schema enum has no 'local' value, local files are recorded as
 * storageRef { provider: 'none', key: <storage key>, url: '' } (see README).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DOCUMENT_ERROR_CODES, DocumentProcessingError } from './documentErrors.js';

export const DEFAULT_LOCAL_STORAGE_DIR = path.join(os.tmpdir(), 'relay-documents');

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.docx', '.txt']);
const KEY_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|docx|txt)$/;

const storageError = (message) => new DocumentProcessingError(DOCUMENT_ERROR_CODES.STORAGE_FAILED, message);

/**
 * Whether a value is a storage key this module could have generated.
 * @param {unknown} key
 */
export function isValidStorageKey(key) {
  return typeof key === 'string' && KEY_REGEX.test(key);
}

/**
 * Creates a local-filesystem storage adapter rooted at `rootDir`.
 *
 * Keys are server-generated UUIDs plus an allowlisted extension; user filenames
 * never touch the filesystem. Writes go to a temp file that is hard-linked to the
 * final key (which fails instead of overwriting) and the temp file is always
 * removed. Errors never include absolute paths.
 *
 * @param {Object} [options]
 * @param {string} [options.rootDir=DEFAULT_LOCAL_STORAGE_DIR]
 */
export function createLocalDocumentStorage({ rootDir = DEFAULT_LOCAL_STORAGE_DIR } = {}) {
  if (typeof rootDir !== 'string' || !rootDir.trim()) throw new TypeError('rootDir must be a non-empty string.');
  const root = path.resolve(rootDir);

  const resolveKey = (key) => {
    if (!isValidStorageKey(key)) throw storageError('Invalid storage key.');
    const full = path.resolve(root, key);
    if (path.dirname(full) !== root) throw storageError('Invalid storage key.');
    return full;
  };

  return {
    name: 'local',

    async put({ buffer, extension } = {}) {
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw storageError('Nothing to store.');
      const ext = String(extension || '').toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) throw storageError('Unsupported storage extension.');

      const key = `${randomUUID()}${ext}`;
      const finalPath = resolveKey(key);
      const tempPath = path.join(root, `.tmp-${randomUUID()}`);

      let writeError = null;
      try {
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        await fs.writeFile(tempPath, buffer, { flag: 'wx', mode: 0o600 });
        await fs.link(tempPath, finalPath); // EEXIST instead of overwriting
      } catch (err) {
        writeError = err;
      }

      // Always remove the temp file; report (never hide) a failure to do so.
      let tempCleanupFailed = false;
      await fs.rm(tempPath, { force: true }).catch(() => { tempCleanupFailed = true; });

      if (writeError) {
        throw storageError(`Could not store the file${writeError.code ? ` (${writeError.code})` : ''}${tempCleanupFailed ? '; temporary file cleanup also failed' : ''}.`);
      }

      return {
        key,
        storageRef: { provider: 'none', key, url: '' },
        warnings: tempCleanupFailed ? [{ code: DOCUMENT_ERROR_CODES.CLEANUP_FAILED, message: 'Temporary upload file could not be removed.' }] : [],
      };
    },

    async delete(key) {
      const full = resolveKey(key);
      try {
        await fs.unlink(full);
        return true;
      } catch (err) {
        if (err?.code === 'ENOENT') return false;
        throw new DocumentProcessingError(DOCUMENT_ERROR_CODES.CLEANUP_FAILED, `Could not delete stored file${err?.code ? ` (${err.code})` : ''}.`);
      }
    },

    async read(key) {
      try {
        return await fs.readFile(resolveKey(key));
      } catch (err) {
        if (err instanceof DocumentProcessingError) throw err;
        throw storageError(`Could not read the stored file${err?.code ? ` (${err.code})` : ''}.`);
      }
    },
  };
}
