import mongoose from 'mongoose';

export const connectDB = async () => {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;

  if (!mongoUri) {
    console.error('❌ MongoDB Connection Error: MONGODB_URI is not defined in .env');
    return null;
  }

  try {
    const conn = await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
    });

    console.log(`🟢 MongoDB Connected: ${conn.connection.host} (DB: ${conn.connection.name})`);
    return conn;
  } catch (error) {
    console.error(`🔴 MongoDB Connection Error: ${error.message}`);
    console.warn('⚠️  Check your MONGODB_URI in .env or ensure your MongoDB service is running.');
  }
};

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️  MongoDB connection disconnected');
});

mongoose.connection.on('reconnected', () => {
  console.log('🟢 MongoDB reconnected');
});

mongoose.connection.on('error', (err) => {
  console.error(`🔴 MongoDB runtime error: ${err.message}`);
});
