import mongoose from 'mongoose';

const { Schema } = mongoose;

export const DOCUMENT_STATUSES = ['uploaded', 'processing', 'indexed', 'failed'];

// Vercel's filesystem is ephemeral, so the actual file bytes live in
// external storage. Person 1 owns the upload/extraction logic and populates
// this; this schema only reserves the shape. provider defaults to 'none'
// until a file is actually uploaded there.
const storageRefSchema = new Schema(
  {
    provider: { type: String, enum: ['vercel-blob', 's3', 'none'], default: 'none' },
    key: { type: String, default: '' },
    url: { type: String, default: '' },
  },
  { _id: false }
);

const documentSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    title: { type: String, required: true, trim: true },
    filename: { type: String, default: '' },
    mimeType: { type: String, default: '' },
    size: { type: Number, default: 0 },
    url: { type: String, default: '' },
    storageRef: { type: storageRefSchema, default: () => ({}) },
    // Full extracted text is only loaded when explicitly selected, so list
    // views never pull large payloads over the wire.
    extractedText: { type: String, default: '', select: false },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    isDemo: { type: Boolean, default: false },
    // Processing lifecycle. Documents are only created after validation + extraction succeeded, so the
    // usual states are processing -> indexed | failed. 'uploaded' is the state of rows that predate chunk indexing.
    status: { type: String, enum: DOCUMENT_STATUSES, default: 'uploaded', index: true },
    // Safe, content-free error summary of the last failed processing attempt.
    statusError: { type: new Schema({ code: String, message: String, at: Date }, { _id: false }), default: undefined },
    contentHash: { type: String, default: '' },
    pageCount: { type: Number, default: undefined },
    chunkCount: { type: Number, default: 0 },
    // Deterministic outline (headings + opening sentence) built at index time; lets handoffs know every document cheaply.
    digest: { type: String, default: '', select: false },
    attempts: { type: Number, default: 0 },
    processingStartedAt: { type: Date, default: undefined },
    indexedAt: { type: Date, default: undefined },
  },
  { timestamps: true }
);

export const Document = mongoose.model('Document', documentSchema);
