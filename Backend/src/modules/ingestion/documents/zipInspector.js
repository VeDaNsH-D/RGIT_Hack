/**
 * @file zipInspector.js
 * @description Bounded, in-memory ZIP inspection used to validate DOCX containers
 * before any parser touches them. Nothing is extracted to disk.
 *
 * Every entry is inflated once with a hard output cap (zlib `maxOutputLength`)
 * and checked against its declared size and CRC-32. After a successful
 * inspection, a downstream parser (mammoth/jszip) can only see entries whose real
 * sizes are known and bounded, which neutralizes zip bombs and lying headers.
 */

import zlib from 'node:zlib';
import { DOCUMENT_ERROR_CODES, DocumentProcessingError } from './documentErrors.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_LENGTH = 0xffff;

export const DEFAULT_ZIP_LIMITS = Object.freeze({
  maxEntries: 2000,
  maxTotalUncompressedBytes: 50 * 1024 * 1024,
});

const malformed = (message) => new DocumentProcessingError(DOCUMENT_ERROR_CODES.MALFORMED_DOCUMENT, message);
const limit = (message) => new DocumentProcessingError(DOCUMENT_ERROR_CODES.LIMIT_EXCEEDED, message);

/**
 * Whether the buffer starts with a ZIP local file header ("PK\x03\x04").
 * @param {Buffer} buffer
 */
export function hasZipSignature(buffer) {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === LOCAL_SIGNATURE;
}

function findEndOfCentralDirectory(buffer) {
  const start = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT_LENGTH);
  for (let i = buffer.length - EOCD_MIN_SIZE; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

function isUnsafeEntryName(name) {
  return name.startsWith('/') || name.includes('\\') || /^[a-zA-Z]:/.test(name)
    || name.split('/').some((segment) => segment === '..') || name.includes('\0');
}

/**
 * Parses and verifies a ZIP archive held in memory.
 *
 * @param {Buffer} buffer
 * @param {Object} [limits]
 * @param {number} [limits.maxEntries]
 * @param {number} [limits.maxTotalUncompressedBytes]
 * @returns {{ entries: Map<string, { name: string, size: number, compressedSize: number }>, readEntry: (name: string) => Buffer, totalUncompressedBytes: number }}
 *   `readEntry` returns the already-verified bytes of an entry.
 * @throws {DocumentProcessingError} MALFORMED_DOCUMENT, ENCRYPTED_DOCUMENT or LIMIT_EXCEEDED.
 */
export function inspectZip(buffer, limits = {}) {
  const maxEntries = limits.maxEntries ?? DEFAULT_ZIP_LIMITS.maxEntries;
  const maxTotal = limits.maxTotalUncompressedBytes ?? DEFAULT_ZIP_LIMITS.maxTotalUncompressedBytes;

  if (!Buffer.isBuffer(buffer) || !hasZipSignature(buffer) || buffer.length < EOCD_MIN_SIZE + 4) {
    throw malformed('File is not a valid ZIP container.');
  }

  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw malformed('ZIP end-of-central-directory record not found.');

  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);

  if (diskNumber !== 0) throw malformed('Multi-part ZIP archives are not supported.');
  if (entryCount === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw malformed('ZIP64 archives are not supported.');
  }
  if (entryCount > maxEntries) throw limit(`Archive has more than ${maxEntries} entries.`);
  if (cdOffset + cdSize > eocd) throw malformed('ZIP central directory is out of bounds.');

  const entries = new Map();
  const contents = new Map();
  let totalUncompressed = 0;
  let pos = cdOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (pos + 46 > eocd || buffer.readUInt32LE(pos) !== CENTRAL_SIGNATURE) {
      throw malformed('ZIP central directory entry is corrupt.');
    }
    const flags = buffer.readUInt16LE(pos + 8);
    const method = buffer.readUInt16LE(pos + 10);
    const crc = buffer.readUInt32LE(pos + 16);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const size = buffer.readUInt32LE(pos + 24);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const nameEnd = pos + 46 + nameLength;
    if (nameEnd > eocd) throw malformed('ZIP entry name is out of bounds.');
    const name = buffer.toString('utf8', pos + 46, nameEnd);
    pos = nameEnd + extraLength + commentLength;

    if (flags & 0x1) {
      throw new DocumentProcessingError(DOCUMENT_ERROR_CODES.ENCRYPTED_DOCUMENT, 'Encrypted documents are not supported.');
    }
    if (isUnsafeEntryName(name)) throw malformed('Archive contains an unsafe entry name.');
    if (entries.has(name)) throw malformed('Archive contains duplicate entry names.');
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw malformed('ZIP64 archives are not supported.');
    }
    if (method !== 0 && method !== 8) throw malformed('Archive uses an unsupported compression method.');

    totalUncompressed += size;
    if (totalUncompressed > maxTotal) throw limit('Archive expands beyond the allowed size.');

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw malformed('ZIP local file header is corrupt.');
    }
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw malformed('ZIP entry data is out of bounds.');
    const raw = buffer.subarray(dataStart, dataEnd);

    let data;
    if (method === 0) {
      data = raw;
    } else {
      try {
        // Cap output at the declared size + 1 so a lying header cannot expand further.
        data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(size, 0) + 1 });
      } catch (err) {
        if (err && err.code === 'ERR_BUFFER_TOO_LARGE') throw limit('Archive entry expands beyond its declared size.');
        throw malformed('Archive entry could not be decompressed.');
      }
    }
    if (data.length !== size) throw malformed('Archive entry size does not match its header.');
    if (zlib.crc32(data) !== crc) throw malformed('Archive entry failed its integrity check.');

    entries.set(name, { name, size, compressedSize });
    contents.set(name, data);
  }

  return {
    entries,
    totalUncompressedBytes: totalUncompressed,
    readEntry(name) {
      const data = contents.get(name);
      if (!data) throw malformed(`Archive entry "${name.slice(0, 100)}" is missing.`);
      return data;
    },
  };
}
