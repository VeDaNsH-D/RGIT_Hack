# WhatsApp Web Automation Delivery Adapter (Selenium)

## 1. Overview & Architecture

The WhatsApp Web delivery adapter is an optional, decoupled notification delivery provider implemented behind the system's standard `DeliveryProvider` interface (`{ name: string, send(notification) }`).

It enables automated notifications to be delivered directly to explicitly authorized recipients via WhatsApp Web using Selenium WebDriver, without relying on undocumented private APIs or violating WhatsApp security boundaries.

### Key Architectural Tenets
- **Isolated Delivery Provider**: Hooks into `NotificationDeliveryDispatcher` in `src/notifications/reliability/dispatcher.js`. Delivery failures in WhatsApp Web never crash or block core in-app notifications.
- **Official Web Interface Only**: Operates purely through controlled browser interaction on `web.whatsapp.com`.
- **Manual First-Time Authentication**: Requires an initial manual scan of the official QR code. Passwords are never requested, scraped, or stored.
- **Privacy & Security First**: Session tokens, credentials, and cookies are never extracted outside the managed browser profile. Sensitive message tokens and secrets are redacted before dispatch.
- **Idempotency & Deduplication**: Tracks delivery attempts by `notification.id` / `eventId` to prevent duplicate messaging after timeouts or browser disconnects.
- **Serialized Browser Execution**: Uses an async mutex queue (`executeSerialized`) to serialize all actions through a single managed browser profile, avoiding profile locking or tab conflicts.

---

## 2. Prerequisites & Installation

### Browser & Driver Prerequisites
1. **Google Chrome** (or Chromium / Firefox / Microsoft Edge) installed on the host system.
2. **Matching WebDriver** (e.g. `chromedriver`):
   - With Selenium WebDriver v4.x+, Selenium Manager automatically downloads and caches the matching browser driver binary for your installed Chrome version.
   - Alternatively, ensure `chromedriver` is available on the system PATH.
3. **Node.js Dependencies**:
   `selenium-webdriver` is installed in `Backend/package.json`.

---

## 3. Configuration

The adapter is disabled by default and can be configured via environment variables in `Backend/.env`:

| Variable | Description | Default |
| :--- | :--- | :--- |
| `WHATSAPP_WEB_ENABLED` | Set to `true` to enable WhatsApp Web delivery. | `false` |
| `WHATSAPP_WEB_BROWSER` | Target browser engine (`chrome`, `firefox`, `edge`). | `chrome` |
| `WHATSAPP_WEB_PROFILE_DIR` | Directory where browser session and cookies persist. | `.whatsapp-sessions` |
| `WHATSAPP_WEB_HEADLESS` | Run browser in headless mode (`true` or `false`). | `false` |
| `WHATSAPP_WEB_NAVIGATION_TIMEOUT_MS` | Page load and navigation timeout in milliseconds. | `30000` |
| `WHATSAPP_WEB_ACTION_TIMEOUT_MS` | Timeout for element interaction and Send verification. | `15000` |
| `WHATSAPP_WEB_AUTH_CHECK_TIMEOUT_MS` | Timeout for detecting login QR codes. | `10000` |

### Profile Directory Security
The persistent profile directory (e.g., `.whatsapp-sessions/` or `whatsapp_profile/`) contains session caches and cookies from your manual login.
- **Git Ignore**: `.whatsapp-sessions/`, `whatsapp_profile/`, and `*.session` are ignored in `.gitignore`.
- **Never commit profile directories, session cookies, or credentials to version control.**

---

## 4. Manual First-Time Login Procedure

Automating QR code login or bypassing two-factor authentication is strictly prohibited. The adapter relies on a dedicated persistent profile directory so that manual login only needs to be completed once.

### Step-by-Step Procedure
1. Ensure `WHATSAPP_WEB_HEADLESS=false` in your `.env` so the browser window is visible.
2. Run the interactive smoke test:
   ```bash
   cd Backend
   npm run smoke:whatsapp
   ```
3. Type `YES` when prompted for authorization.
4. The script opens Chrome with the persistent profile directory (`.whatsapp-sessions`).
5. Scan the official QR code using WhatsApp on your phone (**Linked Devices -> Link a Device**).
6. Once linked, the browser profile stores the session locally in `.whatsapp-sessions/`.
7. Subsequent runs reuse the active session profile automatically without requesting a new QR scan.

---

## 5. Session Expiry & Crash Recovery

### Session Expiry
If WhatsApp Web logs out, the phone disconnects, or the session token expires:
- The adapter detects the login screen (`canvas[aria-label*="QR"]` or landing title).
- Raises `WhatsAppLoginRequiredError` (`code: 'LOGIN_REQUIRED'`).
- The notification dispatcher marks the WhatsApp delivery as `FAILED`, while the in-app notification remains stored and accessible.
- Re-authenticate using the manual login procedure above.

### Browser Crashes & Stale Sessions
If the browser window is closed or crashes during runtime:
- `BrowserSessionManager` catches `NoSuchSessionError` or disconnected socket errors.
- Automatically resets driver references and raises `BrowserCrashedError` (`code: 'BROWSER_CRASHED'`).
- The next delivery attempt starts a fresh browser instance cleanly.

---

## 6. Safe Sending & Recipient Verification

### Recipient Phone Validation
- Recipient phone numbers must adhere strictly to international **E.164** format: `+[country_code][subscriber_number]` (e.g. `+14155552671`).
- Phone numbers without country codes or invalid local formats fail immediately with `InvalidRecipientError` before launching or navigating the browser.

### Recipient Verification
Before clicking the Send button:
1. Navigates to `https://web.whatsapp.com/send?phone=<phone>&text=<encoded_text>`.
2. Inspects for invalid number modals ("*Phone number shared via url is invalid*"). If found, fails with `InvalidRecipientError`.
3. Inspects the active conversation header element. Confirms that visible phone digits match the intended recipient. If ambiguous or mismatched, the adapter aborts with `RecipientVerificationError` without sending.

### Send Confirmation vs. Delivery Guarantees
- **Confirmed UI Submission**: The adapter checks that the Send button was clicked and the input field cleared.
- **Ambiguous Outcomes**: If the browser disconnects or times out immediately after clicking Send, the adapter records `AmbiguousSendOutcomeError` (`code: 'AMBIGUOUS_OUTCOME'`).
- **Duplicate Prevention**: The attempt tracker marks ambiguous attempts as `UNCERTAIN` and blocks automated retries to prevent sending duplicate messages to the user.

---

## 7. Known Delivery Guarantees & Limitations

1. **At-Most-Once / Best-Effort**: WhatsApp Web is a human web interface, not a transactional messaging broker. Exactly-once delivery cannot be mathematically guaranteed over browser automation.
2. **UI Changes**: WhatsApp Web periodically updates its DOM structure and obfuscated class names. The adapter uses resilient attribute-based selectors (`aria-label="Send"`, `data-icon="send"`, `[role="dialog"]`), but significant UI redesigns may require selector updates.
3. **Headless & Server Deployments**:
   - Running in headless environments (e.g. Linux servers, Docker, CI) requires virtual display buffers (Xvfb) or `--headless=new` with proper font rendering.
   - Initial QR code authentication cannot be performed in headless mode; you must either mount a pre-authenticated session profile or run the initial login in a headed environment.

---

## 8. Running Automated Tests

All automated unit and integration tests use a 100% mocked browser abstraction (`MockBrowserDriver`):
- No real WhatsApp accounts or phone numbers required.
- No live network requests or browser windows opened.
- Tests cover all 14 mandatory operational, error, and lifecycle scenarios.

Run the adapter test suite:
```bash
cd Backend
node --test tests/notifications/whatsapp-adapter.test.js
```

Run all notification regression tests:
```bash
node --test tests/notifications/contracts.test.js tests/notifications/service.test.js tests/notifications/reliability.test.js tests/notifications/api.test.js tests/notifications/whatsapp-adapter.test.js test/integration/notifications-delivery.test.js
```
