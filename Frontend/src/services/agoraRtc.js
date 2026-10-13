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
    this.screenVideoTrack = null;
    this.screenAudioTrack = null;
    this.remoteUsers = new Map();
    this.isJoined = false;
    this.callType = 'video'; // 'video' | 'audio'
  }

  get screenTrack() {
    return this.screenVideoTrack;
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

    // Join RTC channel with matching numeric or string account UID
    let joinUid = uid;
    if (!Number.isNaN(Number(uid)) && Number.isInteger(Number(uid)) && Number(uid) > 0) {
      joinUid = Number(uid);
    } else {
      joinUid = String(uid || 'user_guest');
    }

    await this.client.join(appId, channel, token, joinUid);
    this.isJoined = true;

    // Create and publish local tracks independently for maximum device resilience
    try {
      this.localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
        AEC: true,
        ANS: true,
      });
    } catch (audioErr) {
      console.warn('Agora mic track with AEC/ANS failed, attempting standard mic track:', audioErr.message);
      try {
        this.localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack();
      } catch (err2) {
        console.error('Failed to create Agora microphone audio track:', err2.message);
      }
    }

    if (callType === 'video') {
      try {
        this.localVideoTrack = await AgoraRTC.createCameraVideoTrack({
          encoderConfig: '720p_1',
        });
      } catch (videoErr) {
        console.warn('Agora camera track creation failed, attempting standard video track:', videoErr.message);
        try {
          this.localVideoTrack = await AgoraRTC.createCameraVideoTrack();
        } catch (err2) {
          console.error('Failed to create Agora camera video track:', err2.message);
        }
      }
    }

    const tracksToPublish = [];
    if (this.localAudioTrack) tracksToPublish.push(this.localAudioTrack);
    if (this.localVideoTrack) tracksToPublish.push(this.localVideoTrack);

    if (tracksToPublish.length > 0) {
      try {
        await this.client.publish(tracksToPublish);
      } catch (pubErr) {
        console.warn('Failed to publish local audio/video tracks:', pubErr.message);
      }
    }

    return {
      uid: joinUid,
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
      try {
        if (typeof this.localAudioTrack.setMuted === 'function') {
          await this.localAudioTrack.setMuted(!enabled);
        }
      } catch (err) {
        console.warn('setAudioEnabled setMuted error:', err.message);
      }
      try {
        if (typeof this.localAudioTrack.setEnabled === 'function') {
          await this.localAudioTrack.setEnabled(enabled);
        }
      } catch (err) {
        console.warn('setAudioEnabled setEnabled error:', err.message);
      }
    } else if (enabled && this.isJoined && this.client) {
      // Dynamically acquire and publish microphone track if missing on unmute
      try {
        this.localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({ AEC: true, ANS: true });
        await this.client.publish([this.localAudioTrack]);
      } catch (err) {
        console.warn('Failed dynamic mic track creation on unmute:', err.message);
      }
    }
  }

  /**
   * Toggles camera video track.
   * @param {boolean} enabled
   */
  async setVideoEnabled(enabled) {
    if (this.localVideoTrack) {
      try {
        if (typeof this.localVideoTrack.setMuted === 'function') {
          await this.localVideoTrack.setMuted(!enabled);
        }
      } catch (err) {
        console.warn('setVideoEnabled setMuted error:', err.message);
      }
      try {
        if (typeof this.localVideoTrack.setEnabled === 'function') {
          await this.localVideoTrack.setEnabled(enabled);
        }
      } catch (err) {
        console.warn('setVideoEnabled setEnabled error:', err.message);
      }
    } else if (enabled && this.isJoined && this.client && this.callType === 'video') {
      try {
        this.localVideoTrack = await AgoraRTC.createCameraVideoTrack({ encoderConfig: '720p_1' });
        await this.client.publish([this.localVideoTrack]);
      } catch (err) {
        console.warn('Failed dynamic camera track creation on unmute:', err.message);
      }
    }
  }

  /**
   * Starts screen sharing by publishing a screen video track (and audio track if available).
   * @param {() => void} [onEnded] Callback when user stops sharing via browser native UI.
   * @returns {Promise<import('agora-rtc-sdk-ng').ILocalVideoTrack | null>}
   */
  async startScreenShare(onEnded) {
    if (!this.client || !this.isJoined) {
      console.warn('Cannot share screen: RTC client not initialized or joined');
      return null;
    }

    try {
      if (this.screenVideoTrack) {
        await this.stopScreenShare();
      }

      // Agora createScreenVideoTrack with 'auto' returns either [videoTrack, audioTrack] or single videoTrack
      const screenResult = await AgoraRTC.createScreenVideoTrack(
        {
          encoderConfig: '1080p_2',
          optimizationMode: 'detail',
        },
        'auto'
      );

      let videoTrack = null;
      let audioTrack = null;

      if (Array.isArray(screenResult)) {
        videoTrack = screenResult[0];
        audioTrack = screenResult[1] || null;
      } else {
        videoTrack = screenResult;
      }

      if (!videoTrack) {
        console.warn('No video track returned for screen share');
        return null;
      }

      this.screenVideoTrack = videoTrack;
      this.screenAudioTrack = audioTrack;

      // Temporarily unpublish camera track while presenting screen
      if (this.localVideoTrack && this.client) {
        try {
          await this.client.unpublish([this.localVideoTrack]);
        } catch (unpubErr) {
          console.warn('Could not unpublish camera track during screen share start:', unpubErr.message);
        }
      }

      // Publish screen track(s)
      const tracksToPublish = audioTrack ? [videoTrack, audioTrack] : [videoTrack];
      await this.client.publish(tracksToPublish);

      // Listen for browser native "Stop sharing" event
      videoTrack.on('track-ended', async () => {
        await this.stopScreenShare();
        if (typeof onEnded === 'function') {
          onEnded();
        }
      });

      return videoTrack;
    } catch (err) {
      console.warn('Screen share cancelled or failed:', err.message);
      return null;
    }
  }

  /**
   * Stops screen share and restores local camera if active.
   */
  async stopScreenShare() {
    const tracksToUnpublish = [];
    if (this.screenVideoTrack) tracksToUnpublish.push(this.screenVideoTrack);
    if (this.screenAudioTrack) tracksToUnpublish.push(this.screenAudioTrack);

    if (tracksToUnpublish.length > 0 && this.client) {
      try {
        await this.client.unpublish(tracksToUnpublish);
      } catch (err) {
        console.warn('Error unpublishing screen track(s):', err.message);
      }
    }

    if (this.screenVideoTrack) {
      try {
        this.screenVideoTrack.stop();
        this.screenVideoTrack.close();
      } catch {}
      this.screenVideoTrack = null;
    }

    if (this.screenAudioTrack) {
      try {
        this.screenAudioTrack.stop();
        this.screenAudioTrack.close();
      } catch {}
      this.screenAudioTrack = null;
    }

    // Restore local camera if call was video mode and track exists
    if (this.localVideoTrack && this.client && this.callType === 'video') {
      try {
        await this.client.publish([this.localVideoTrack]);
      } catch (err) {
        console.warn('Error restoring camera track after screen share:', err.message);
      }
    }
  }

  /**
   * Leaves the channel and cleans up all media tracks.
   */
  async leave() {
    await this.stopScreenShare();

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
