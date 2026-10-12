/**
 * Agora RTC Service Wrapper
 *
 * Handles WebRTC audio/video call lifecycle: joining channels, local track creation,
 * remote user subscription, track mute/unmute, and safe teardown.
 */

import AgoraRTC from 'agora-rtc-sdk-ng';

// Configure Agora RTC client logging level
AgoraRTC.setLogLevel(2); // 0: DEBUG, 1: INFO, 2: WARNING, 3: ERROR, 4: NONE

export class AgoraRtcManager {
  constructor() {
    this.client = null;
    this.localAudioTrack = null;
    this.localVideoTrack = null;
    this.remoteUsers = new Map();
    this.isJoined = false;
    this.callType = 'video'; // 'video' | 'audio'
  }

  /**
   * Initializes and joins an Agora RTC channel.
   *
   * @param {object} params
   * @param {string} params.appId Agora App ID
   * @param {string} params.channel Channel name
   * @param {string} params.token RTC Token from backend
   * @param {string|number} params.uid User ID
   * @param {'audio'|'video'} [params.callType='video']
   * @param {object} [callbacks={}]
   * @param {(user: any, mediaType: string) => void} [callbacks.onUserPublished]
   * @param {(user: any, mediaType: string) => void} [callbacks.onUserUnpublished]
   * @param {(user: any) => void} [callbacks.onUserLeft]
   */
  async join({
    appId,
    channel,
    token,
    uid,
    callType = 'video',
  }, callbacks = {}) {
    if (this.isJoined) {
      await this.leave();
    }

    this.callType = callType;
    this.client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });

    // Handle remote user publishing tracks
    this.client.on('user-published', async (user, mediaType) => {
      await this.client.subscribe(user, mediaType);
      this.remoteUsers.set(user.uid, user);

      if (mediaType === 'audio') {
        user.audioTrack?.play();
      }

      if (typeof callbacks.onUserPublished === 'function') {
        callbacks.onUserPublished(user, mediaType);
      }
    });

    // Handle remote user unpublishing
    this.client.on('user-unpublished', (user, mediaType) => {
      if (typeof callbacks.onUserUnpublished === 'function') {
        callbacks.onUserUnpublished(user, mediaType);
      }
    });

    // Handle remote user leaving
    this.client.on('user-left', (user) => {
      this.remoteUsers.delete(user.uid);
      if (typeof callbacks.onUserLeft === 'function') {
        callbacks.onUserLeft(user);
      }
    });

    // Join RTC channel
    await this.client.join(appId, channel, token, uid);
    this.isJoined = true;

    // Create and publish local tracks
    try {
      if (callType === 'video') {
        const [audioTrack, videoTrack] = await AgoraRTC.createMicrophoneAndCameraTracks(
          { AEC: true, ANS: true },
          { encoderConfig: '720p_1' }
        );
        this.localAudioTrack = audioTrack;
        this.localVideoTrack = videoTrack;
        await this.client.publish([this.localAudioTrack, this.localVideoTrack]);
      } else {
        // Audio-only call
        this.localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
          AEC: true,
          ANS: true,
        });
        await this.client.publish([this.localAudioTrack]);
      }
    } catch (trackErr) {
      console.warn('Microphone/Camera access restricted or unavailable:', trackErr.message);
    }

    return {
      uid,
      channel,
      localAudioTrack: this.localAudioTrack,
      localVideoTrack: this.localVideoTrack,
    };
  }

  /**
   * Toggles microphone audio mute/unmute.
   * @param {boolean} enabled
   */
  async setAudioEnabled(enabled) {
    if (this.localAudioTrack) {
      await this.localAudioTrack.setEnabled(enabled);
    }
  }

  /**
   * Toggles camera video track.
   * @param {boolean} enabled
   */
  async setVideoEnabled(enabled) {
    if (this.localVideoTrack) {
      await this.localVideoTrack.setEnabled(enabled);
    }
  }

  /**
   * Starts screen sharing by publishing a screen video track.
   */
  async startScreenShare() {
    if (!this.client || !this.isJoined) return null;
    try {
      this.screenTrack = await AgoraRTC.createScreenVideoTrack({}, 'enable');
      if (this.localVideoTrack) {
        await this.client.unpublish([this.localVideoTrack]);
      }
      await this.client.publish([this.screenTrack]);
      this.screenTrack.on('track-ended', () => {
        this.stopScreenShare().catch(() => {});
      });
      return this.screenTrack;
    } catch (err) {
      console.warn('Screen share cancelled or failed:', err.message);
      return null;
    }
  }

  /**
   * Stops screen share and restores local camera if active.
   */
  async stopScreenShare() {
    if (this.screenTrack && this.client) {
      try {
        await this.client.unpublish([this.screenTrack]);
        this.screenTrack.stop();
        this.screenTrack.close();
      } catch (err) {
        console.warn('Error stopping screen track:', err.message);
      }
      this.screenTrack = null;
    }
    if (this.localVideoTrack && this.client) {
      try {
        await this.client.publish([this.localVideoTrack]);
      } catch (err) {
        console.warn('Error restoring camera track:', err.message);
      }
    }
  }

  /**
   * Leaves the channel and cleans up all media tracks.
   */
  async leave() {
    if (this.screenTrack) {
      try {
        this.screenTrack.stop();
        this.screenTrack.close();
      } catch {}
      this.screenTrack = null;
    }

    if (this.localAudioTrack) {
      this.localAudioTrack.stop();
      this.localAudioTrack.close();
      this.localAudioTrack = null;
    }

    if (this.localVideoTrack) {
      this.localVideoTrack.stop();
      this.localVideoTrack.close();
      this.localVideoTrack = null;
    }

    if (this.client) {
      try {
        await this.client.leave();
      } catch (err) {
        console.warn('Error during RTC client leave:', err.message);
      }
      this.client = null;
    }

    this.remoteUsers.clear();
    this.isJoined = false;
  }
}
