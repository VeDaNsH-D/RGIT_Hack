import mongoose from 'mongoose';

const { Schema } = mongoose;

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
  },
  { timestamps: true }
);

export const Document = mongoose.model('Document', documentSchema);
