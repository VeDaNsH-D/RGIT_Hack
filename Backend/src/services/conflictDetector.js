/**
 * @file conflictDetector.js
 * @description Deterministic conflict comparison engine for the Express backend.
 * Evaluates authoritative project records to identify factual contradictions
 * (deadline mismatches and status mismatches) without directly persisting conflicts to the database.
 */

import crypto from 'node:crypto';
import { conflictDetectionResultSchema } from '../contracts/schemas.js';

const OPEN_STATUSES = new Set(['open', 'in_progress', 'pending', 'reopened', 'active']);
const CLOSED_STATUSES = new Set(['completed', 'closed', 'resolved', 'merged', 'done']);

/**
 * Normalizes subject string for consistent matching across records.
 */
export function normalizeSubject(subject) {
  if (!subject || typeof subject !== 'string') return '';
  const stopWords = new Set(['the', 'a', 'an', 'to', 'for', 'in', 'on', 'of', 'and', 'with', 'by']);
  return subject
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopWords.has(w))
    .join(' ');
}

/**
 * Computes deterministic fingerprint for conflict deduplication.
 */
export function computeFingerprint(category, subjectKey, idA, idB) {
  const sortedIds = [String(idA), String(idB)].sort();
  const raw = `${category}:${subjectKey}:${sortedIds[0]}:${sortedIds[1]}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/**
 * Normalizes a date string or Date object to YYYY-MM-DD for equality checking.
 */
export function normalizeDate(dateVal) {
  if (!dateVal) return null;
  const str = typeof dateVal === 'string' ? dateVal : (dateVal instanceof Date ? dateVal.toISOString() : String(dateVal));
  const match = str.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

/**
 * Extracts normalized facts from project records.
 *
 * @param {object} args
 * @param {Array<object>} [args.tasks]
 * @param {Array<object>} [args.documents]
 * @param {Array<object>} [args.sourceRecords]
 * @returns {Array<object>} List of extracted facts.
 */
export function extractFacts({ tasks = [], documents = [], sourceRecords = [] }) {
  const facts = [];

  // 1. Facts from tasks
  for (const t of tasks) {
    const id = String(t._id || t.id);
    const title = t.title || 'Untitled Task';
    const createdAt = t.createdAt ? new Date(t.createdAt).toISOString() : null;

    if (t.deadline) {
      const normDeadline = normalizeDate(t.deadline);
      if (normDeadline) {
        facts.push({
          factType: 'deadline',
          subject: title,
          value: normDeadline,
          sourceRecordId: id,
          sourceType: 'task',
          excerpt: `Task '${title}' has deadline ${normDeadline}`,
          timestamp: createdAt,
        });
      }
    }

    if (t.status) {
      const statusLower = String(t.status).toLowerCase().trim();
      facts.push({
        factType: 'status',
        subject: title,
        value: statusLower,
        sourceRecordId: id,
        sourceType: 'task',
        excerpt: `Task '${title}' has status ${statusLower}`,
        timestamp: createdAt,
      });
    }
  }

  // 2. Facts from source records
  for (const s of sourceRecords) {
    const id = String(s._id || s.id);
    const title = s.title || '';
    const content = s.content || '';
    const textLower = `${title} ${content}`.toLowerCase();
    const normSourceText = normalizeSubject(`${title} ${content}`);
    const sType = s.type || s.recordType || s.provider || 'source_record';
    const createdAt = s.createdAt ? new Date(s.createdAt).toISOString() : null;

    for (const t of tasks) {
      const taskKey = normalizeSubject(t.title);
      if (!taskKey) continue;

      if (normSourceText.includes(taskKey) || textLower.includes(taskKey)) {
        // Status declaration check
        if (/\b(merged|completed|resolved|closed|deployed|fixed)\b/.test(textLower)) {
          facts.push({
            factType: 'status',
            subject: t.title,
            value: 'completed',
            sourceRecordId: id,
            sourceType: sType,
            excerpt: `Source '${title}' indicates completion/merge for '${t.title}'`,
            timestamp: createdAt,
          });
        } else if (/\b(open|reopened|pending|in progress|blocked)\b/.test(textLower)) {
          facts.push({
            factType: 'status',
            subject: t.title,
            value: 'open',
            sourceRecordId: id,
            sourceType: sType,
            excerpt: `Source '${title}' indicates open/pending state for '${t.title}'`,
            timestamp: createdAt,
          });
        }

        // Deadline declaration check
        const dateMatch = content.match(/\b(\d{4}-\d{2}-\d{2})\b/);
        if (dateMatch && /\b(deadline|due|cutoff)\b/i.test(textLower)) {
          facts.push({
            factType: 'deadline',
            subject: t.title,
            value: dateMatch[1],
            sourceRecordId: id,
            sourceType: sType,
            excerpt: `Source '${title}' specifies deadline ${dateMatch[1]} for '${t.title}'`,
            timestamp: createdAt,
          });
        }
      }
    }
  }

  // 3. Facts from documents
  for (const d of documents) {
    const id = String(d._id || d.id);
    const title = d.title || '';
    const text = d.extractedText || '';
    const textLower = text.toLowerCase();
    const normDocText = normalizeSubject(`${title} ${text}`);
    const createdAt = d.createdAt ? new Date(d.createdAt).toISOString() : null;

    for (const t of tasks) {
      const taskKey = normalizeSubject(t.title);
      if (!taskKey) continue;

      if (normDocText.includes(taskKey) || textLower.includes(taskKey)) {
        const dateMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
        if (dateMatch && /\b(deadline|due|must complete)\b/i.test(textLower)) {
          facts.push({
            factType: 'deadline',
            subject: t.title,
            value: dateMatch[1],
            sourceRecordId: id,
            sourceType: 'document',
            excerpt: `Document '${title}' specifies deadline ${dateMatch[1]} for '${t.title}'`,
            timestamp: createdAt,
          });
        }
      }
    }
  }

  return facts;
}

/**
 * Deterministically compares facts and detects conflicts.
 *
 * @param {object} args
 * @param {string} args.projectId
 * @param {Array<object>} [args.tasks]
 * @param {Array<object>} [args.documents]
 * @param {Array<object>} [args.sourceRecords]
 * @param {Array<object>} [args.facts] - Optional pre-extracted facts.
 * @returns {object} Validated conflict detection result adhering to conflictDetectionResultSchema.
 */
export function detectProjectConflicts({
  projectId,
  tasks = [],
  documents = [],
  sourceRecords = [],
  facts = null,
}) {
  const evaluatedFacts = facts || extractFacts({ tasks, documents, sourceRecords });
  const conflicts = [];
  const seenFingerprints = new Set();

  // Group facts by factType + normalized subject
  const groups = new Map();
  for (const f of evaluatedFacts) {
    const key = `${f.factType}:${normalizeSubject(f.subject)}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(f);
  }

  for (const [key, group] of groups.entries()) {
    if (group.length < 2) continue;
    const [factType, subjectKey] = key.split(':');

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const fa = group[i];
        const fb = group[j];

        // Must originate from distinct source records
        if (fa.sourceRecordId === fb.sourceRecordId) continue;

        // 1. Deadline mismatch
        if (factType === 'deadline') {
          if (fa.value !== fb.value) {
            const fingerprint = computeFingerprint('deadline_mismatch', subjectKey, fa.sourceRecordId, fb.sourceRecordId);
            if (!seenFingerprints.has(fingerprint)) {
              seenFingerprints.add(fingerprint);

              let temporalNote = '';
              if (fa.timestamp && fb.timestamp) {
                if (new Date(fa.timestamp) > new Date(fb.timestamp)) {
                  temporalNote = ` (Source '${fa.sourceRecordId}' is newer than Source '${fb.sourceRecordId}')`;
                } else if (new Date(fb.timestamp) > new Date(fa.timestamp)) {
                  temporalNote = ` (Source '${fb.sourceRecordId}' is newer than Source '${fa.sourceRecordId}')`;
                }
              }

              conflicts.push({
                title: `Deadline mismatch for '${fa.subject}' (${fa.value} vs ${fb.value})`,
                category: 'deadline_mismatch',
                description: `Conflicting deadlines found for '${fa.subject}': Source '${fa.sourceRecordId}' specifies ${fa.value}, whereas Source '${fb.sourceRecordId}' specifies ${fb.value}.${temporalNote}`,
                severity: 'high',
                fingerprint,
                evidence: [
                  {
                    sourceType: fa.sourceType,
                    sourceRecordId: fa.sourceType !== 'document' ? fa.sourceRecordId : null,
                    documentId: fa.sourceType === 'document' ? fa.sourceRecordId : null,
                    excerpt: fa.excerpt,
                    url: null,
                    timestamp: fa.timestamp,
                  },
                  {
                    sourceType: fb.sourceType,
                    sourceRecordId: fb.sourceType !== 'document' ? fb.sourceRecordId : null,
                    documentId: fb.sourceType === 'document' ? fb.sourceRecordId : null,
                    excerpt: fb.excerpt,
                    url: null,
                    timestamp: fb.timestamp,
                  },
                ],
                detectedAt: new Date().toISOString(),
              });
            }
          }
        }

        // 2. Status mismatch
        else if (factType === 'status') {
          const isAOpen = OPEN_STATUSES.has(fa.value);
          const isAClosed = CLOSED_STATUSES.has(fa.value);
          const isBOpen = OPEN_STATUSES.has(fb.value);
          const isBClosed = CLOSED_STATUSES.has(fb.value);

          const isConflict = (isAOpen && isBClosed) || (isAClosed && isBOpen);
          if (isConflict) {
            const fingerprint = computeFingerprint('status_mismatch', subjectKey, fa.sourceRecordId, fb.sourceRecordId);
            if (!seenFingerprints.has(fingerprint)) {
              seenFingerprints.add(fingerprint);

              let temporalNote = '';
              if (fa.timestamp && fb.timestamp) {
                if (new Date(fa.timestamp) > new Date(fb.timestamp)) {
                  temporalNote = ` (Source '${fa.sourceRecordId}' is newer than Source '${fb.sourceRecordId}')`;
                } else if (new Date(fb.timestamp) > new Date(fa.timestamp)) {
                  temporalNote = ` (Source '${fb.sourceRecordId}' is newer than Source '${fa.sourceRecordId}')`;
                }
              }

              conflicts.push({
                title: `Status mismatch for '${fa.subject}' ('${fa.value}' vs '${fb.value}')`,
                category: 'status_mismatch',
                description: `Conflicting statuses recorded for '${fa.subject}': Source '${fa.sourceRecordId}' reports status '${fa.value}', while Source '${fb.sourceRecordId}' reports status '${fb.value}'.${temporalNote}`,
                severity: 'medium',
                fingerprint,
                evidence: [
                  {
                    sourceType: fa.sourceType,
                    sourceRecordId: fa.sourceType !== 'document' ? fa.sourceRecordId : null,
                    documentId: fa.sourceType === 'document' ? fa.sourceRecordId : null,
                    excerpt: fa.excerpt,
                    url: null,
                    timestamp: fa.timestamp,
                  },
                  {
                    sourceType: fb.sourceType,
                    sourceRecordId: fb.sourceType !== 'document' ? fb.sourceRecordId : null,
                    documentId: fb.sourceType === 'document' ? fb.sourceRecordId : null,
                    excerpt: fb.excerpt,
                    url: null,
                    timestamp: fb.timestamp,
                  },
                ],
                detectedAt: new Date().toISOString(),
              });
            }
          }
        }
      }
    }
  }

  const rawResult = {
    projectId: String(projectId),
    conflictCount: conflicts.length,
    conflicts,
    evaluatedFactCount: evaluatedFacts.length,
    evaluatedAt: new Date().toISOString(),
  };

  // Validate with Zod before returning to ensure backend contract integrity
  return conflictDetectionResultSchema.parse(rawResult);
}
