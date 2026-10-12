/**
 * Browser Session Manager
 * 
 * Manages the Selenium WebDriver lifecycle: session reuse, profile directory preservation,
 * crash recovery, async mutex serialization for concurrency safety, and graceful shutdown.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  BrowserStartupError,
  BrowserCrashedError,
  BrowserShutdownError,
} from './whatsappErrors.js';

export class BrowserSessionManager {
  /**
   * @param {object} config
   * @param {string} [config.browser='chrome']
   * @param {string} config.profileDir Path to persistent browser profile
   * @param {boolean} [config.headless=false]
   * @param {number} [config.navigationTimeoutMs=30000]
   * @param {number} [config.actionTimeoutMs=15000]
   * @param {() => Promise<any>} [config.driverFactory] Custom factory for testing/mocking
   */
  constructor({
    browser = 'chrome',
    profileDir = '.whatsapp-sessions',
    headless = false,
    navigationTimeoutMs = 30000,
    actionTimeoutMs = 15000,
    driverFactory = null,
  } = {}) {
    this.browser = browser.toLowerCase();
    this.profileDir = path.isAbsolute(profileDir)
      ? profileDir
      : path.resolve(process.cwd(), profileDir);
    this.headless = Boolean(headless);
    this.navigationTimeoutMs = navigationTimeoutMs;
    this.actionTimeoutMs = actionTimeoutMs;
    this.driverFactory = driverFactory;

    this._driver = null;
    this._isStarting = false;
    this._isShuttingDown = false;

    // Mutex queue to guarantee strictly serialized browser interactions
    this._queue = Promise.resolve();
  }

  /**
   * Ensures the browser profile directory exists.
   */
  _ensureProfileDirectory() {
    try {
      if (!fs.existsSync(this.profileDir)) {
        fs.mkdirSync(this.profileDir, { recursive: true });
      }
    } catch (err) {
      throw new BrowserStartupError(
        `Failed to create browser profile directory at '${this.profileDir}': ${err.message}`,
        err
      );
    }
  }

  /**
   * Creates a new real WebDriver instance using selenium-webdriver.
   */
  async _createDefaultDriver() {
    this._ensureProfileDirectory();

    try {
      const selenium = await import('selenium-webdriver');
      const { Builder } = selenium.default || selenium;

      const builder = new Builder().forBrowser(this.browser);

      if (this.browser === 'chrome') {
        const chrome = await import('selenium-webdriver/chrome.js');
        const ChromeOptions = chrome.Options || chrome.default?.Options;
        const options = new ChromeOptions();

        options.addArguments(`--user-data-dir=${this.profileDir}`);
        options.addArguments('--no-sandbox');
        options.addArguments('--disable-dev-shm-usage');
        options.addArguments('--disable-gpu');
        options.addArguments('--window-size=1280,800');

        if (this.headless) {
          options.addArguments('--headless=new');
        }

        builder.setChromeOptions(options);
      } else if (this.browser === 'firefox') {
        const firefox = await import('selenium-webdriver/firefox.js');
        const FirefoxOptions = firefox.Options || firefox.default?.Options;
        const options = new FirefoxOptions();
        options.setProfile(this.profileDir);
        if (this.headless) {
          options.addArguments('-headless');
        }
        builder.setFirefoxOptions(options);
      } else if (this.browser === 'edge') {
        const edge = await import('selenium-webdriver/edge.js');
        const EdgeOptions = edge.Options || edge.default?.Options;
        const options = new EdgeOptions();
        options.addArguments(`--user-data-dir=${this.profileDir}`);
        if (this.headless) {
          options.addArguments('--headless=new');
        }
        builder.setEdgeOptions(options);
      }

      const driver = await builder.build();

      // Configure timeouts
      try {
        await driver.manage().setTimeouts({
          pageLoad: this.navigationTimeoutMs,
          implicit: 0, // Prefer resilient explicit waits over implicit
        });
      } catch {
        // Fallback if setTimeouts is not supported by driver
      }

      return driver;
    } catch (err) {
      throw new BrowserStartupError(
        `Failed to start browser driver for '${this.browser}': ${err.message}`,
        err
      );
    }
  }

  /**
   * Gets or initializes the managed browser driver session.
   * 
   * @returns {Promise<any>}
   */
  async getDriver() {
    if (this._isShuttingDown) {
      throw new BrowserShutdownError('Cannot obtain browser driver during shutdown.');
    }

    if (this._driver) {
      // Validate driver session liveness
      try {
        if (typeof this._driver.getSession === 'function') {
          const session = await this._driver.getSession();
          if (session) return this._driver;
        } else {
          return this._driver;
        }
      } catch (err) {
        // Driver session crashed or closed
        this._driver = null;
      }
    }

    if (this._isStarting) {
      // Wait a moment for startup to complete
      await new Promise((r) => setTimeout(r, 200));
      return this.getDriver();
    }

    this._isStarting = true;
    try {
      if (typeof this.driverFactory === 'function') {
        this._driver = await this.driverFactory();
      } else {
        this._driver = await this._createDefaultDriver();
      }
      return this._driver;
    } catch (err) {
      this._driver = null;
      if (err instanceof BrowserStartupError) throw err;
      throw new BrowserStartupError(`Browser initialization failed: ${err.message}`, err);
    } finally {
      this._isStarting = false;
    }
  }

  /**
   * Serializes execution through an async FIFO queue to prevent concurrent tab
   * or profile collisions in the single browser instance.
   * 
   * @template T
   * @param {(driver: any) => Promise<T>} task
   * @returns {Promise<T>}
   */
  async executeSerialized(task) {
    if (this._isShuttingDown) {
      throw new BrowserShutdownError('Cannot execute task: Browser session is shutting down.');
    }

    return new Promise((resolve, reject) => {
      this._queue = this._queue
        .then(async () => {
          if (this._isShuttingDown) {
            throw new BrowserShutdownError('Task aborted: Browser session is shutting down.');
          }
          const driver = await this.getDriver();
          return await task(driver);
        })
        .then(resolve)
        .catch((err) => {
          // Check if error was a browser crash
          if (
            err &&
            (err.name === 'NoSuchSessionError' ||
              err.name === 'WebDriverError' ||
              (err.message && err.message.includes('session deleted')) ||
              (err.message && err.message.includes('chrome not reachable')))
          ) {
            this._driver = null;
            reject(new BrowserCrashedError(`Browser crashed or disconnected: ${err.message}`, err));
          } else {
            reject(err);
          }
        });
    });
  }

  /**
   * Gracefully shuts down the browser session and releases all resources.
   * 
   * @returns {Promise<void>}
   */
  async shutdown() {
    this._isShuttingDown = true;
    const currentDriver = this._driver;
    this._driver = null;

    if (currentDriver && typeof currentDriver.quit === 'function') {
      try {
        await currentDriver.quit();
      } catch (err) {
        // Best-effort cleanup
      }
    }
  }

  /**
   * Resets shutdown flag (useful for tests).
   */
  reset() {
    this._isShuttingDown = false;
    this._driver = null;
    this._queue = Promise.resolve();
  }
}
