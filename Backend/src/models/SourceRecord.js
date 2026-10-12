import mongoose from 'mongoose';

const { Schema } = mongoose;

// Ingested items from Person 1's module (commits, PRs, docs, tickets, ...).
// Upserted by (projectId, provider, externalId) so re-ingestion never
// creates duplicates.
const sourceRecordSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    provider: { type: String, required: true, trim: true },
    externalId: { type: String, required: true, trim: true },
    type: { type: String, default: '', trim: true },
    title: { type: String, default: '', trim: true },
    url: { type: String, default: '' },
    content: { type: String, default: '' },
    metadata: { type: Schema.Types.Mixed, default: {} },
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true }
);

sourceRecordSchema.index({ projectId: 1, provider: 1, externalId: 1 }, { unique: true });

export const SourceRecord = mongoose.model('SourceRecord', sourceRecordSchema);
