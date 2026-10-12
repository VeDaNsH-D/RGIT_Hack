#!/usr/bin/env node
/**
 * WhatsApp Web One-Time Device Authentication Helper
 * 
 * Opens WhatsApp Web in Chrome using the persistent profile directory (.whatsapp-sessions).
 * Displays clear instructions for the user to scan the QR code with their mobile device,
 * and automatically detects when login is complete.
 * 
 * Usage:
 *   npm run login:whatsapp
 *   or
 *   node scripts/whatsapp-login.js
 */

import {
  BrowserSessionManager,
  resolveWhatsAppConfig,
} from '../src/notifications/whatsapp/index.js';

async function main() {
  console.log('=====================================================');
  console.log('      WhatsApp Web - One-Time Device Linking');
  console.log('=====================================================\n');

  const config = resolveWhatsAppConfig({
    enabled: true,
    headless: false, // Ensure Chrome is visible for QR code scanning
  });

  console.log(`- Browser profile: ${config.profileDir}`);
  console.log('- Launching Chrome...\n');

  const sessionManager = new BrowserSessionManager({
    browser: config.browser,
    profileDir: config.profileDir,
    headless: false,
    navigationTimeoutMs: 60000,
  });

  let driver = null;

  const cleanup = async () => {
    try {
      await sessionManager.shutdown();
    } catch {
      // Ignore cleanup error on exit
    }
  };

  process.on('SIGINT', async () => {
    console.log('\nAborted by user.');
    await cleanup();
    process.exit(0);
  });

  try {
    await sessionManager.executeSerialized(async (activeDriver) => {
      driver = activeDriver;
      console.log('Navigating to https://web.whatsapp.com ...');
      await driver.get('https://web.whatsapp.com');

      console.log('\n-----------------------------------------------------');
      console.log('INSTRUCTIONS:');
      console.log('1. Open WhatsApp on your phone.');
      console.log('2. Tap Settings (iOS) or Three dots (Android) > "Linked Devices".');
      console.log('3. Tap "Link a Device" and scan the QR code in Chrome.');
      console.log('-----------------------------------------------------\n');
      console.log('Waiting for QR code scan and login...');

      // Polling loop to detect authentication
      const maxWaitMs = 180000; // 3 minutes
      const startTime = Date.now();
      let loggedIn = false;

      while (Date.now() - startTime < maxWaitMs) {
        try {
          // Check if post-login elements appear
          const chatElements = await driver.findElements({
            css: '#pane-side, [data-testid="chat-list"], header [data-testid="chat-list-header"], div[id="pane-side"] div[role="row"]',
          });

          if (chatElements && chatElements.length > 0) {
            loggedIn = true;
            break;
          }

          // Check if QR code is still visible
          const qrElements = await driver.findElements({
            css: 'canvas[aria-label*="QR"], [data-ref*="qr"], [data-testid="qrcode"]',
          });

          if ((!qrElements || qrElements.length === 0) && (Date.now() - startTime > 15000)) {
            // QR is gone and page has loaded beyond initial splash
            const anyHeader = await driver.findElements({ css: 'header' });
            if (anyHeader && anyHeader.length > 0) {
              loggedIn = true;
              break;
            }
          }
        } catch {
          // Ignore polling errors while page navigates
        }

        await new Promise((r) => setTimeout(r, 1500));
      }

      if (loggedIn) {
        console.log('\n=====================================================');
        console.log('[SUCCESS] WhatsApp Web authenticated successfully!');
        console.log('Your session profile has been securely saved in:');
        console.log(`  ${config.profileDir}`);
        console.log('\nYou can now send WhatsApp notifications using:');
        console.log('  npm run smoke:whatsapp');
        console.log('=====================================================\n');
      } else {
        console.log('\n[TIMEOUT] Login was not detected within 3 minutes.');
        console.log('If you scanned the code, the profile might already be saved.');
        console.log('You can test by running: npm run smoke:whatsapp\n');
      }

      // Keep browser open for a brief confirmation
      await new Promise((r) => setTimeout(r, 4000));
    });
  } catch (err) {
    console.error('\n[ERROR] Failed during WhatsApp login setup:', err.message);
  } finally {
    console.log('Closing browser session...');
    await cleanup();
    console.log('Done.');
  }
}

main().catch((err) => {
  console.error('Fatal error in login script:', err);
  process.exit(1);
});
