import mongoose from 'mongoose';

const { Schema } = mongoose;

// PROPOSED (pending Person 2 sign-off): a generated, downloadable developer handoff report. It is
// independent of the team ownership-transfer Handoff, so previewing or downloading a report never creates one.
const handoffReportSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    projectName: { type: String, required: true },
    generatedAt: { type: Date, required: true },
    summary: { type: String, required: true },
    // [{ key, title, origin: 'deterministic'|'ai', items: [{ text, kind, evidence: [{ id, label, url }] }] }]
    sections: { type: [Schema.Types.Mixed], required: true },
    // [{ fullName, commitSha, analyzedAt, status, coverage, freshness }]
    repositories: { type: [Schema.Types.Mixed], default: [] },
    limitations: { type: [String], default: [] },
    basedOn: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

handoffReportSchema.index({ projectId: 1, generatedAt: -1 });

export const HandoffReport = mongoose.model('HandoffReport', handoffReportSchema);
