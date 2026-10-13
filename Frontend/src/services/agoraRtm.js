/**
 * Agora RTM 2.x Real-Time Messaging Service Wrapper
 * 
 * Provides real-time text chat, channel subscription, message publishing,
 * and user presence events using the official Agora RTM SDK.
 */

import AgoraRTM from 'agora-rtm-sdk';

export class AgoraRtmManager {
  constructor() {
    this.rtm = null;
    this.currentChannel = null;
    this.isLoggedIn = false;
    this.userId = null;
    this.messageCallbacks = new Set();
    this.presenceCallbacks = new Set();
    this.statusCallbacks = new Set();
  }

  /**
   * Initializes and logs into Agora RTM service.
   * 
   * @param {object} params
   * @param {string} params.appId Agora App ID
   * @param {string} params.userId User ID
   * @param {string} params.token RTM token from backend
   * @param {object} [callbacks={}]
   * @param {(text: string, sender: string, event: any) => void} [callbacks.onMessage]
   * @param {(event: any) => void} [callbacks.onPresence]
   * @param {(event: any) => void} [callbacks.onStatus]
   */
  async login({ appId, userId, token }, callbacks = {}) {
    if (this.isLoggedIn) {
      await this.logout();
    }

    this.userId = String(userId);
    const RTMClass = AgoraRTM.RTM || AgoraRTM.default?.RTM || AgoraRTM;

    this.rtm = new RTMClass(appId, this.userId, {
      token,
      useStringUserId: true,
    });

    if (typeof callbacks.onMessage === 'function') {
      this.messageCallbacks.add(callbacks.onMessage);
    }
    if (typeof callbacks.onPresence === 'function') {
      this.presenceCallbacks.add(callbacks.onPresence);
    }
    if (typeof callbacks.onStatus === 'function') {
      this.statusCallbacks.add(callbacks.onStatus);
    }

    // Register event listeners on the Agora RTM instance
    this.rtm.addEventListener('message', (event) => {
      let text = '';
      if (typeof event.message === 'string') {
        text = event.message;
      } else if (event.message instanceof Uint8Array) {
        try {
          text = new TextDecoder().decode(event.message);
        } catch {
          text = String(event.message);
        }
      } else if (event.message && typeof event.message.data === 'string') {
        text = event.message.data;
      } else if (typeof event.data === 'string') {
        text = event.data;
      } else if (event.message) {
        try {
          text = JSON.stringify(event.message);
        } catch {
          text = String(event.message);
        }
      }

      const sender = event.publisher || event.senderId || event.userId || 'Teammate';

      for (const cb of this.messageCallbacks) {
        try {
          cb(text, sender, event);
        } catch (cbErr) {
          console.warn('[AgoraRtmManager] message callback error:', cbErr);
        }
      }
    });

    this.rtm.addEventListener('presence', (event) => {
      for (const cb of this.presenceCallbacks) {
        try {
          cb(event);
        } catch (cbErr) {
          console.warn('[AgoraRtmManager] presence callback error:', cbErr);
        }
      }
    });

    this.rtm.addEventListener('status', (event) => {
      for (const cb of this.statusCallbacks) {
        try {
          cb(event);
        } catch (cbErr) {
          console.warn('[AgoraRtmManager] status callback error:', cbErr);
        }
      }
    });

    // Login to RTM network
    await this.rtm.login();
    this.isLoggedIn = true;
  }

  /**
   * Subscribes to a chat channel.
   * 
   * @param {string} channelName
   * @param {object} [callbacks={}]
   * @param {(text: string, sender: string, event: any) => void} [callbacks.onMessage]
   * @param {(event: any) => void} [callbacks.onPresence]
   */
  async joinChannel(channelName, callbacks = {}) {
    if (!this.isLoggedIn || !this.rtm) {
      throw new Error('Must log into Agora RTM before joining a channel.');
    }

    this.currentChannel = channelName;

    if (callbacks && typeof callbacks.onMessage === 'function') {
      this.messageCallbacks.add(callbacks.onMessage);
    }
    if (callbacks && typeof callbacks.onPresence === 'function') {
      this.presenceCallbacks.add(callbacks.onPresence);
    }

    await this.rtm.subscribe(channelName, {
      withMessage: true,
      withPresence: true,
    });
  }

  /**
   * Publishes a text message to the channel.
   * Can be invoked as sendMessage(channelName, messageText) or sendMessage(messageText).
   * 
   * @param {string} channelOrText
   * @param {string} [maybeText]
   * @returns {Promise<any>}
   */
  async sendMessage(channelOrText, maybeText) {
    if (!this.isLoggedIn || !this.rtm) {
      throw new Error('Agora RTM is not connected.');
    }

    let targetChannel = this.currentChannel;
    let messageText = channelOrText;

    if (typeof maybeText !== 'undefined') {
      targetChannel = channelOrText || this.currentChannel;
      messageText = maybeText;
    }

    if (!targetChannel) {
      throw new Error('No target channel specified or joined for RTM message.');
    }

    const payload = typeof messageText === 'string' ? messageText : JSON.stringify(messageText ?? '');

    return await this.rtm.publish(targetChannel, payload, {
      channelType: 'MESSAGE',
    });
  }

  /**
   * Leaves the current channel.
   */
  async leaveChannel() {
    if (this.rtm && this.currentChannel) {
      try {
        await this.rtm.unsubscribe(this.currentChannel);
      } catch (err) {
        console.warn('Error unsubscribing channel:', err.message);
      }
      this.currentChannel = null;
    }
    this.messageCallbacks.clear();
    this.presenceCallbacks.clear();
  }

  /**
   * Logs out and cleans up RTM instance.
   */
  async logout() {
    await this.leaveChannel();

    if (this.rtm && this.isLoggedIn) {
      try {
        await this.rtm.logout();
      } catch (err) {
        console.warn('Error during RTM logout:', err.message);
      }
      this.rtm = null;
      this.isLoggedIn = false;
      this.statusCallbacks.clear();
    }
  }
}
