#!/usr/bin/env node
/**
 * WhatsApp Cloud API Smoke Test Script
 * 
 * Interactive smoke test tool for verifying WhatsApp Cloud API delivery (Twilio or Meta).
 * Dispatches a test notification via direct HTTP REST API without any browser automation or QR codes.
 * Fixed sender: +919021875564.
 * 
 * Usage:
 *   node scripts/whatsapp-cloud-smoke.js
 *   npm run smoke:whatsapp-cloud
 */

import readline from 'node:readline';
import {
  WhatsAppCloudApiAdapter,
} from '../src/notifications/whatsapp/index.js';
import { NOTIFICATION_EVENT_TYPES } from '../src/notifications/index.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

async function main() {
  console.log('=====================================================');
  console.log('       WhatsApp Cloud API Delivery Smoke Test');
  console.log('=====================================================\n');

  const provider = (
    process.env.WHATSAPP_CLOUD_PROVIDER ||
    (process.env.META_WHATSAPP_TOKEN ? 'meta' : 'twilio')
  ).toLowerCase();

  const fromPhone = process.env.WHATSAPP_FROM_PHONE || process.env.TWILIO_WHATSAPP_FROM || '+919021875564';

  console.log('Current Configuration:');
  console.log(`- Provider:             ${provider.toUpperCase()}`);
  console.log(`- Fixed Sender (From):  ${fromPhone}`);

  if (provider === 'meta') {
    const hasToken = Boolean(process.env.META_WHATSAPP_TOKEN);
    const phoneId = process.env.META_WHATSAPP_PHONE_NUMBER_ID || '(not set)';
    console.log(`- Meta Phone Number ID: ${phoneId}`);
    console.log(`- Meta Token Present:   ${hasToken}\n`);
    if (!hasToken || !process.env.META_WHATSAPP_PHONE_NUMBER_ID) {
      console.warn('[WARNING] Meta credentials missing. Please set META_WHATSAPP_TOKEN and META_WHATSAPP_PHONE_NUMBER_ID in Backend/.env.');
    }
  } else {
    const sid = process.env.TWILIO_ACCOUNT_SID ? process.env.TWILIO_ACCOUNT_SID.slice(0, 6) + '...' : '(not set)';
    const hasAuth = Boolean(process.env.TWILIO_AUTH_TOKEN);
    console.log(`- Twilio Account SID:   ${sid}`);
    console.log(`- Twilio Auth Token:    ${hasAuth ? 'Set' : '(not set)'}\n`);
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      console.warn('[WARNING] Twilio credentials missing. Please set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in Backend/.env.');
    }
  }

  const proceed = await askQuestion(
    'Authorize sending a test WhatsApp notification? Type YES to proceed: '
  );

  if (proceed.trim() !== 'YES') {
    console.log('\n[ABORTED] Test aborted by user.');
    rl.close();
    process.exit(0);
  }

  const defaultRecipient = '+919021875564';
  const phoneInput = await askQuestion(
    `Enter destination recipient phone number [default: ${defaultRecipient}]: `
  );
  const targetPhone = phoneInput.trim() || defaultRecipient;

  if (!targetPhone.startsWith('+')) {
    console.error('\n[ERROR] Phone number must be in E.164 format with country code (e.g. +919021875564).');
    rl.close();
    process.exit(1);
  }

  rl.close();

  const adapter = new WhatsAppCloudApiAdapter({
    config: {
      provider,
      fromPhone,
    },
  });

  const smokeNotification = {
    id: `cloud_smoke_${Date.now()}`,
    eventId: `evt_cloud_${Date.now()}`,
    type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
    title: 'Cloud WhatsApp Integration Verification',
    message: 'Automated test notification from Relay Cloud WhatsApp Adapter.',
    projectId: 'relay-core',
    entityId: 'handoff-prod-001',
    recipientUserId: 'cloud-test-user',
    recipientPhone: targetPhone,
    createdAt: new Date().toISOString(),
    deliveryStatus: 'PENDING',
  };

  console.log(`\nDispatching WhatsApp notification to ${targetPhone} via ${provider.toUpperCase()}...`);

  try {
    const result = await adapter.send(smokeNotification);
    console.log('\n=====================================================');
    console.log('[SUCCESS] Message dispatched successfully!');
    console.log('Result:');
    console.log(JSON.stringify(result, null, 2));
    console.log('=====================================================\n');
  } catch (err) {
    console.error('\n[FAILURE] Dispatch failed:');
    console.error(`- Error:   ${err.message}`);
    console.error(`- Details: ${err.code || 'UNKNOWN'}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal smoke test error:', err);
  process.exit(1);
});
