# Ingestion & Integrations Module (Relay)

> **Status:** Agreed Application Contract (Aligned with Core Backend & Persistence)  
> **Module Owner:** Person 1 (Integrations & Data Ingestion Engineer)

---

## 1. Module Purpose

This module is responsible for ingesting raw data from external project artifacts (GitHub, uploaded documents), normalizing it into unified `SourceRecordCandidate` objects, and preparing it for persistence.

Supported initial sources:
- **GitHub**: Repository metadata, issues, pull requests, and commits.
- **Documents**: Uploaded files in `.pdf`, `.docx`, and `.txt` formats.

---

## 2. Agreed `SourceRecordCandidate` Contract

All ingested items are transformed into normalized `SourceRecordCandidate` objects prior to persistence:

```javascript
{
  projectId: string,         // Relay internal project ID
  provider: "github" | "document",
  recordType: "repository" | "issue" | "pull_request" | "commit" | "document",
  externalId: string,        // Provider-unique or repository-qualified identifier
  title: string,             // Human-readable title
  content: string,           // Normalized text body for AI analysis
  contentType: string,       // Media type ('text/markdown', 'text/plain')
  url?: string,              // Canonical URL back to external source (provenance)
  author?: string,           // Creator/committer name or handle
  authorId?: string,         // Provider user ID
  createdAt?: Date,          // Source entity creation timestamp
  updatedAt?: Date,          // Source entity modification timestamp
  fetchedAt: Date,           // Ingestion batch timestamp
  version: number,           // Schema version (1)
  isActive: boolean,         // Context active status
  isDeleted: boolean,        // Source/Relay soft delete flag
  metadata?: Record<string, unknown>, // Provider-specific supplementary attributes
  pageNumber?: number,       // Document chunk page number
  passageReference?: string, // Document passage reference
  extractionStatus?: string  // Extraction lifecycle status
}
```

Implementation details and enums are defined in [`contracts/sourceRecord.js`](./contracts/sourceRecord.js).

---

## 3. Candidate vs. Persisted Record

- **`SourceRecordCandidate` (Person 1)**: Produced by normalization. **Never** assigns internal database IDs (`id` or `_id`).
- **`SourceRecord` (Person 2)**: Persisted representation stored in MongoDB, carrying an assigned internal ID owned and managed by Person 2's persistence layer.

---

## 4. Timestamps & Provenance

- `createdAt`: Source creation time (issue created, commit authored).
- `updatedAt`: Source update time (issue modified, commit committed).
- `fetchedAt`: Relay ingestion execution time.
- *`observedAt` is deprecated and excluded from the normalized contract.*
