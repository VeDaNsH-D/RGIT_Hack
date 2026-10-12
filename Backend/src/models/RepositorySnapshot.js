import mongoose from 'mongoose';

const { Schema } = mongoose;

// PROPOSED (pending Person 2 sign-off): a commit-versioned, structured understanding of one connected
// repository. Only snapshots with status completed|partial are ever published (referenced from
// SourceConnection.config.analysis.currentSnapshotId); an interrupted run leaves an unpublished row.
const repositorySnapshotSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    connectionId: { type: Schema.Types.ObjectId, ref: 'SourceConnection', required: true },
    repositoryId: { type: Number, required: true },
    fullName: { type: String, required: true },
    branch: { type: String, required: true },
    commitSha: { type: String, required: true },
    analyzerVersion: { type: Number, required: true },
    status: { type: String, enum: ['completed', 'partial', 'failed'], required: true },
    mode: { type: String, enum: ['full', 'incremental'], required: true },
    analyzedAt: { type: Date, required: true },
    coverage: { type: Schema.Types.Mixed, required: true },
    changes: { type: Schema.Types.Mixed, default: null },
    // [{ path, blobSha, size, category }] for every file whose content was analyzed.
    fileManifest: { type: [Schema.Types.Mixed], default: [] },
    knowledge: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);

repositorySnapshotSchema.index({ projectId: 1, connectionId: 1, analyzedAt: -1 });
repositorySnapshotSchema.index({ connectionId: 1, commitSha: 1 });

export const RepositorySnapshot = mongoose.model('RepositorySnapshot', repositorySnapshotSchema);
