import mongoose from 'mongoose';

const { Schema } = mongoose;

// Represents a configured integration (e.g. a connected GitHub repo) that
// Person 1's ingestion module uses to know where to pull SourceRecords from.
const sourceConnectionSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    provider: { type: String, required: true, trim: true },
    config: { type: Schema.Types.Mixed, default: {} },
    connectedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const SourceConnection = mongoose.model('SourceConnection', sourceConnectionSchema);
