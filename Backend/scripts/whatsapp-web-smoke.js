#!/usr/bin/env node
/**
 * WhatsApp Web Automation Smoke Test Script
 * 
 * Interactive smoke test tool for manual verification of WhatsApp Web Selenium automation.
 * STRICT SAFETY REQUIREMENT: Requires explicit human authorization before sending any live message.
 * 
 * Usage:
 *   node scripts/whatsapp-web-smoke.js
 */

import readline from 'node:readline';
import {
  WhatsAppWebSeleniumAdapter,
  resolveWhatsAppConfig,
} from '../src/notifications/whatsapp/index.js';
import { NOTIFICATION_EVENT_TYPES } from '../src/notifications/index.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

async function main() {
  console.log('=====================================================');
  console.log('   WhatsApp Web Automation Selenium Smoke Test');
  console.log('=====================================================\n');

  const config = resolveWhatsAppConfig();

  console.log('Current Configuration:');
  console.log(`- Enabled:                ${config.enabled}`);
  console.log(`- Browser:                ${config.browser}`);
  console.log(`- Profile Directory:      ${config.profileDir}`);
  console.log(`- Headless Mode:          ${config.headless}`);
  console.log(`- Navigation Timeout:     ${config.navigationTimeoutMs}ms\n`);

  console.log('SAFETY WARNING:');
  console.log('This test will open WhatsApp Web in a controlled browser window.');
  console.log('If you are not yet logged in, you must scan the official QR code manually.');
  console.log('No passwords or credentials will ever be requested or stored.\n');

  const proceed = await askQuestion(
    'Do you explicitly authorize running this smoke test? Type YES to proceed: '
  );

  if (proceed.trim() !== 'YES') {
    console.log('\n[ABORTED] Explicit human confirmation not provided. No browser or message was launched.');
    rl.close();
    process.exit(0);
  }

  const phone = await askQuestion(
    'Enter authorized recipient phone number with country code (e.g., +14155552671): '
  );

  if (!phone || !phone.trim().startsWith('+')) {
    console.error('\n[ERROR] Phone number must be in international E.164 format starting with +.');
    rl.close();
    process.exit(1);
  }

  const finalConfirm = await askQuestion(
    `CONFIRM: Send a test notification to ${phone.trim()}? Type SEND to execute: `
  );

  if (finalConfirm.trim() !== 'SEND') {
    console.log('\n[ABORTED] Final confirmation not given. Delivery aborted.');
    rl.close();
    process.exit(0);
  }

  rl.close();

  console.log('\nInitializing WhatsApp Web Selenium adapter...');
  const adapter = new WhatsAppWebSeleniumAdapter({
    config: {
      ...config,
      enabled: true,
      headless: false, // Ensure window is visible for user to view or scan QR
    },
  });

  const smokeNotification = {
    id: `smoke_notif_${Date.now()}`,
    eventId: `smoke_evt_${Date.now()}`,
    type: NOTIFICATION_EVENT_TYPES.HANDOFF_SUBMITTED,
    title: 'Relay Smoke Test Notification',
    message: 'Manual smoke test verifying WhatsApp Web Selenium delivery adapter.',
    projectId: 'smoke-test-project',
    entityId: 'smoke-handoff-001',
    recipientUserId: 'smoke-test-user',
    recipientPhone: phone.trim(),
    createdAt: new Date().toISOString(),
    deliveryStatus: 'PENDING',
  };

  try {
    console.log('Dispatching smoke test notification...');
    const result = await adapter.send(smokeNotification);
    console.log('\n[SUCCESS] Notification delivered successfully:');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('\n[FAILURE] Delivery failed:');
    console.error(`- Error Code: ${err.code || 'UNKNOWN'}`);
    console.error(`- Error Message: ${err.message}`);
    if (err.code === 'LOGIN_REQUIRED') {
      console.log('\nFirst-time login hint:');
      console.log('1. Scan the displayed QR code on WhatsApp Web using your mobile device.');
      console.log('2. Once logged in, your session profile will be preserved in .whatsapp-sessions.');
      console.log('3. Run this smoke test again to send the message.');
    }
  } finally {
    console.log('\nCleaning up browser session...');
    await adapter.shutdown();
    console.log('Done.');
  }
}

main().catch((err) => {
  console.error('Fatal smoke test error:', err);
  process.exit(1);
});
