import mongoose from 'mongoose';

const { Schema } = mongoose;

// PROPOSED (pending Person 2 sign-off): single-use, short-lived install state.
// Only the SHA-256 of the state value is stored. Consumed atomically with
// findOneAndDelete; the TTL index removes unused rows.
const gitHubInstallStateSchema = new Schema({
  stateHash: { type: String, required: true, unique: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
});

export const GitHubInstallState = mongoose.model('GitHubInstallState', gitHubInstallStateSchema);
