import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Single-use, short-lived OAuth install state for Slack.
 * Only the SHA-256 of the state value is stored.
 * Consumed atomically with findOneAndDelete; TTL index removes expired rows.
 */
const slackInstallStateSchema = new Schema({
  stateHash: { type: String, required: true, unique: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
});

export const SlackInstallState = mongoose.model('SlackInstallState', slackInstallStateSchema);
