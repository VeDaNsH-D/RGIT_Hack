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
  }

  /**
   * Initializes and logs into Agora RTM service.
   * 
   * @param {object} params
   * @param {string} params.appId Agora App ID
   * @param {string} params.userId User ID
   * @param {string} params.token RTM token from backend
   * @param {object} [callbacks={}]
   * @param {(event: any) => void} [callbacks.onMessage]
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

    // Register event listeners
    if (typeof callbacks.onMessage === 'function') {
      this.rtm.addEventListener('message', (event) => {
        callbacks.onMessage(event);
      });
    }

    if (typeof callbacks.onPresence === 'function') {
      this.rtm.addEventListener('presence', (event) => {
        callbacks.onPresence(event);
      });
    }

    if (typeof callbacks.onStatus === 'function') {
      this.rtm.addEventListener('status', (event) => {
        callbacks.onStatus(event);
      });
    }

    // Login to RTM network
    await this.rtm.login();
    this.isLoggedIn = true;
  }

  /**
   * Subscribes to a chat channel.
   * 
   * @param {string} channelName
   */
  async joinChannel(channelName) {
    if (!this.isLoggedIn || !this.rtm) {
      throw new Error('Must log into Agora RTM before joining a channel.');
    }

    this.currentChannel = channelName;
    await this.rtm.subscribe(channelName, {
      withMessage: true,
      withPresence: true,
    });
  }

  /**
   * Publishes a text message to the channel.
   * 
   * @param {string} channelName
   * @param {string} messageText
   * @returns {Promise<any>}
   */
  async sendMessage(channelName, messageText) {
    if (!this.isLoggedIn || !this.rtm) {
      throw new Error('Agora RTM is not connected.');
    }

    const payload = typeof messageText === 'string' ? messageText : JSON.stringify(messageText);

    return await this.rtm.publish(channelName, payload, {
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
    }
  }
}
