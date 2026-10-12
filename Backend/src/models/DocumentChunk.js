import mongoose from 'mongoose';

const { Schema } = mongoose;

// Bounded, citable slices of a document's extracted text. This is the unit of retrieval for handoff context
// (lexical/structured retrieval; there is no embedding index). Identity is (projectId, documentId, chunkIndex),
// so re-indexing the same document overwrites rows instead of duplicating them.
const documentChunkSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true },
    chunkIndex: { type: Number, required: true },
    chunkId: { type: String, required: true }, // `${documentId}:${chunkIndex}`
    text: { type: String, required: true },
    charCount: { type: Number, required: true },
    chunkHash: { type: String, required: true },
    contentHash: { type: String, required: true }, // hash of the document version this chunk belongs to
    heading: { type: String, default: '' },
    pageStart: { type: Number, default: undefined },
    pageEnd: { type: Number, default: undefined },
    filename: { type: String, default: '' },
    title: { type: String, default: '' },
    uploadedAt: { type: Date },
  },
  { timestamps: true }
);

documentChunkSchema.index({ projectId: 1, documentId: 1, chunkIndex: 1 }, { unique: true });

export const DocumentChunk = mongoose.model('DocumentChunk', documentChunkSchema);
