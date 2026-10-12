import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    phone: { type: String, required: true },
    sandboxCode: { type: String, default: 'join fear-company' },
    sandboxNumber: { type: String, default: '+14155238886' },
    active: { type: Boolean, default: true },
    connectedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export const WhatsAppConnection = mongoose.model('WhatsAppConnection', schema);
