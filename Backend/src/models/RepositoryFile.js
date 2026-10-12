import mongoose from 'mongoose';

const { Schema } = mongoose;

// PROPOSED (pending Person 2 sign-off): immutable, content-addressed cache of analyzed file text, keyed by the
// Git blob SHA. Content is never stored for excluded files, binaries, or files that matched a secret pattern.
// Rows no longer referenced by a published snapshot are deleted after each publish.
const repositoryFileSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    repositoryId: { type: Number, required: true },
    path: { type: String, required: true },
    blobSha: { type: String, required: true },
    size: { type: Number, required: true },
    truncated: { type: Boolean, default: false },
    content: { type: String, required: true, select: false },
  },
  { timestamps: true }
);

repositoryFileSchema.index({ projectId: 1, repositoryId: 1, path: 1, blobSha: 1 }, { unique: true });

export const RepositoryFile = mongoose.model('RepositoryFile', repositoryFileSchema);
