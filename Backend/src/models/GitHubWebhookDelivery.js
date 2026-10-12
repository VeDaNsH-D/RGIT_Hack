import mongoose from 'mongoose';

const { Schema } = mongoose;

// PROPOSED (pending Person 2 sign-off): GitHub delivery ids already handled, for replay/retry de-duplication.
// Rows expire after 7 days.
const gitHubWebhookDeliverySchema = new Schema({
  deliveryId: { type: String, required: true, unique: true },
  receivedAt: { type: Date, required: true, default: Date.now, index: { expireAfterSeconds: 7 * 24 * 3600 } },
});

export const GitHubWebhookDelivery = mongoose.model('GitHubWebhookDelivery', gitHubWebhookDeliverySchema);
