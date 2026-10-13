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
    complexity: { type: String, enum: ['small', 'medium', 'large'], default: undefined },
    // First-page engineering brief: { summary, currentState: [item], doFirst: [item], attention: [item] }. Absent on reports created before v5.
    brief: { type: Schema.Types.Mixed, default: undefined },
    // Deterministic verification status: tests discovered/executed, runtime, requirements, work tracking, completion, coverage.
    verification: { type: Schema.Types.Mixed, default: undefined },
    // Compact numbered source list; items carry `refs` (numbers) into it.
    sourceIndex: { type: [Schema.Types.Mixed], default: [] },
    // [{ key, title, origin: 'deterministic'|'ai', items: [{ text, kind, refs, evidence: [{ id, label, url }], ...type-specific fields }] }]
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
