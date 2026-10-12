import mongoose from 'mongoose';

const { Schema } = mongoose;

const conflictEvidenceSchema = new Schema(
  {
    conflictId: { type: Schema.Types.ObjectId, ref: 'Conflict', required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    sourceType: { type: String, required: true, trim: true },
    sourceRecordId: { type: Schema.Types.ObjectId, ref: 'SourceRecord', default: null },
    documentId: { type: Schema.Types.ObjectId, ref: 'Document', default: null },
    excerpt: { type: String, required: true, trim: true },
    url: { type: String, default: '' },
  },
  { timestamps: true }
);

export const ConflictEvidence = mongoose.model('ConflictEvidence', conflictEvidenceSchema);
