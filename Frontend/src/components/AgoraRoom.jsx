import React, { useState, useEffect, useRef } from 'react';
import { AgoraRtcManager } from '../services/agoraRtc';
import { AgoraRtmManager } from '../services/agoraRtm';
import './AgoraRoom.css';

export function AgoraRoom() {
  const [channelName, setChannelName] = useState('relay-live-room');
  const [userId, setUserId] = useState(`dev_${Math.floor(1000 + Math.random() * 9000)}`);
  const [callType, setCallType] = useState('video'); // 'video' | 'audio'
  const [isConnected, setIsConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Media track state
  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(true);
  const [callDuration, setCallDuration] = useState(0);

  // Remote users
  const [remoteUsers, setRemoteUsers] = useState([]);

  // Chat state
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState('');

  // Refs for instances
  const rtcManagerRef = useRef(new AgoraRtcManager());
  const rtmManagerRef = useRef(new AgoraRtmManager());
  const localPlayerRef = useRef(null);
  const timerRef = useRef(null);
  const chatBottomRef = useRef(null);

  // Auto-scroll chat
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Call duration timer
  useEffect(() => {
    if (isConnected) {
      timerRef.current = setInterval(() => {
        setCallDuration((prev) => prev + 1);
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      setCallDuration(0);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isConnected]);

  const formatTimer = (seconds) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  /**
   * Fetches Agora tokens from backend and connects RTC & RTM.
   */
  const handleJoin = async () => {
    if (!channelName.trim()) {
      setError('Please provide a channel name.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // 1. Fetch Tokens from Backend
      const tokenRes = await fetch('/api/agora/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': userId, // Dev header for auth
        },
        body: JSON.stringify({
          channelName: channelName.trim(),
          callType,
          role: 'publisher',
        }),
      });

      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.success) {
        throw new Error(tokenData.message || 'Failed to obtain Agora tokens from backend');
      }

      const { appId, rtcToken, rtmToken } = tokenData.data;

      // 2. Join Agora RTC (Audio & Video Calling)
      const rtc = rtcManagerRef.current;
      await rtc.join(
        {
          appId,
          channel: channelName.trim(),
          token: rtcToken,
          uid: userId,
          callType,
        },
        {
          onUserPublished: (user, mediaType) => {
            setRemoteUsers((prev) => {
              const existing = prev.filter((u) => u.uid !== user.uid);
              return [...existing, user];
            });

            // Bind video stream to DOM
            if (mediaType === 'video') {
              setTimeout(() => {
                const container = document.getElementById(`remote-player-${user.uid}`);
                if (container) {
                  user.videoTrack?.play(container);
                }
              }, 100);
            }
          },
          onUserUnpublished: (user, mediaType) => {
            if (mediaType === 'video') {
              setRemoteUsers((prev) => prev.map((u) => (u.uid === user.uid ? { ...u, hasVideo: false } : u)));
            }
          },
          onUserLeft: (user) => {
            setRemoteUsers((prev) => prev.filter((u) => u.uid !== user.uid));
          },
        }
      );

      // Play local video track if enabled
      if (callType === 'video' && rtc.localVideoTrack && localPlayerRef.current) {
        rtc.localVideoTrack.play(localPlayerRef.current);
      }

      // 3. Connect Agora RTM (Real-Time Text Chat)
      const rtm = rtmManagerRef.current;
      await rtm.login(
        {
          appId,
          userId,
          token: rtmToken,
        },
        {
          onMessage: (event) => {
            const incomingText = typeof event.message === 'string' ? event.message : event.message?.text || JSON.stringify(event.message);
            setMessages((prev) => [
              ...prev,
              {
                id: `msg_${Date.now()}_${Math.random()}`,
                sender: event.publisher || 'Remote User',
                text: incomingText,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                isMe: false,
              },
            ]);
          },
        }
      );

      await rtm.joinChannel(channelName.trim());

      setIsConnected(true);
      setMessages((prev) => [
        ...prev,
        {
          id: `sys_${Date.now()}`,
          sender: 'System',
          text: `Connected to Agora Channel '${channelName}' as ${userId}. Audio, Video, and Chat initialized.`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          isSystem: true,
        },
      ]);
    } catch (err) {
      console.error('Failed to join Agora session:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Leaves both RTC call and RTM chat channels cleanly.
   */
  const handleLeave = async () => {
    try {
      await rtcManagerRef.current.leave();
      await rtmManagerRef.current.logout();
    } catch (err) {
      console.warn('Error during leave:', err);
    }

    setIsConnected(false);
    setRemoteUsers([]);
    setMessages((prev) => [
      ...prev,
      {
        id: `sys_${Date.now()}`,
        sender: 'System',
        text: 'Disconnected from Agora session.',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isSystem: true,
      },
    ]);
  };

  /**
   * Toggles microphone audio.
   */
  const toggleMic = async () => {
    const nextState = !micEnabled;
    await rtcManagerRef.current.setAudioEnabled(nextState);
    setMicEnabled(nextState);
  };

  /**
   * Toggles camera video.
   */
  const toggleCam = async () => {
    const nextState = !camEnabled;
    await rtcManagerRef.current.setVideoEnabled(nextState);
    setCamEnabled(nextState);
  };

  /**
   * Sends a real-time chat message through Agora RTM.
   */
  const handleSendMessage = async (e) => {
    e?.preventDefault();
    if (!messageInput.trim() || !isConnected) return;

    const textToSend = messageInput.trim();
    setMessageInput('');

    try {
      await rtmManagerRef.current.sendMessage(channelName.trim(), textToSend);
      setMessages((prev) => [
        ...prev,
        {
          id: `msg_${Date.now()}`,
          sender: userId,
          text: textToSend,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          isMe: true,
        },
      ]);
    } catch (err) {
      console.error('Failed sending RTM message:', err);
      setError(`Failed to send chat message: ${err.message}`);
    }
  };

  return (
    <div className="agora-container">
      {/* Top Header */}
      <header className="agora-header">
        <div className="header-brand">
          <span className="live-indicator-dot" style={{ backgroundColor: isConnected ? '#10b981' : '#6b7280' }}></span>
          <h2>Agora Real-Time Communication Hub</h2>
        </div>
        <div className="status-badge" style={{ borderColor: isConnected ? '#10b981' : '#4b5563' }}>
          {isConnected ? (
            <span style={{ color: '#10b981' }}>● LIVE ({callType.toUpperCase()}) - {formatTimer(callDuration)}</span>
          ) : (
            <span style={{ color: '#9ca3af' }}>DISCONNECTED</span>
          )}
        </div>
      </header>

      {/* Control Configuration Bar */}
      <div className="agora-config-card">
        <div className="config-grid">
          <div className="input-group">
            <label>Channel Name</label>
            <input
              type="text"
              value={channelName}
              disabled={isConnected}
              onChange={(e) => setChannelName(e.target.value)}
              placeholder="e.g. relay-standup"
            />
          </div>

          <div className="input-group">
            <label>Your User ID</label>
            <input
              type="text"
              value={userId}
              disabled={isConnected}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="e.g. dev_user_1"
            />
          </div>

          <div className="input-group">
            <label>Call Mode</label>
            <select
              value={callType}
              disabled={isConnected}
              onChange={(e) => setCallType(e.target.value)}
            >
              <option value="video">📹 Video Call (+ Audio & Chat)</option>
              <option value="audio">🎙️ Audio Call (+ Chat)</option>
            </select>
          </div>

          <div className="action-group">
            {!isConnected ? (
              <button
                className="btn-join"
                onClick={handleJoin}
                disabled={loading}
              >
                {loading ? 'Connecting to Agora...' : 'Join Agora Session'}
              </button>
            ) : (
              <button className="btn-leave" onClick={handleLeave}>
                End Call / Leave
              </button>
            )}
          </div>
        </div>

        {error && <div className="error-alert">⚠️ {error}</div>}
      </div>

      {/* Main Grid: Video/Audio Stage + Real-Time Chat */}
      <div className="agora-stage-layout">
        {/* Left: Call Stage */}
        <section className="media-stage-card">
          <div className="stage-header">
            <h3>{callType === 'video' ? 'Video Conference Stage' : 'Audio Call Stage'}</h3>
            {isConnected && (
              <div className="media-toggles">
                <button
                  className={`btn-toggle ${!micEnabled ? 'off' : ''}`}
                  onClick={toggleMic}
                  title={micEnabled ? 'Mute Microphone' : 'Unmute Microphone'}
                >
                  {micEnabled ? '🎤 Mic ON' : '🔇 Mic MUTED'}
                </button>
                {callType === 'video' && (
                  <button
                    className={`btn-toggle ${!camEnabled ? 'off' : ''}`}
                    onClick={toggleCam}
                    title={camEnabled ? 'Turn Off Camera' : 'Turn On Camera'}
                  >
                    {camEnabled ? '📹 Cam ON' : '📷 Cam OFF'}
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="video-grid">
            {/* Local Video Stream Container */}
            <div className="video-card local-stream">
              <div
                id="local-player"
                ref={localPlayerRef}
                className="video-player-container"
              >
                {(!isConnected || callType === 'audio' || !camEnabled) && (
                  <div className="audio-avatar-placeholder">
                    <div className="avatar-circle">
                      {userId.slice(0, 2).toUpperCase()}
                    </div>
                    <span className="avatar-name">{userId} (You)</span>
                    <span className="avatar-role">
                      {!isConnected ? 'Offline' : callType === 'audio' ? 'Audio Connected' : 'Camera Off'}
                    </span>
                  </div>
                )}
              </div>
              <div className="stream-badge">
                You ({userId}) {micEnabled ? '🎙️' : '🔇'}
              </div>
            </div>

            {/* Remote Video Stream Containers */}
            {remoteUsers.length > 0 ? (
              remoteUsers.map((user) => (
                <div key={user.uid} className="video-card remote-stream">
                  <div
                    id={`remote-player-${user.uid}`}
                    className="video-player-container"
                  >
                    {callType === 'audio' && (
                      <div className="audio-avatar-placeholder">
                        <div className="avatar-circle remote">
                          {String(user.uid).slice(0, 2).toUpperCase()}
                        </div>
                        <span className="avatar-name">{user.uid}</span>
                        <span className="avatar-role">Audio Connected</span>
                      </div>
                    )}
                  </div>
                  <div className="stream-badge">Remote: {user.uid}</div>
                </div>
              ))
            ) : (
              <div className="video-card empty-remote-slot">
                <div className="empty-slot-content">
                  <span className="slot-icon">👥</span>
                  <p>Waiting for peers to join channel: <strong>{channelName}</strong></p>
                  <small>Share the channel name with teammates to connect live.</small>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Right: Real-Time Text Chat */}
        <section className="chat-card">
          <div className="chat-header">
            <h3>💬 Agora Real-Time Chat (RTM)</h3>
            <span className="channel-pill">#{channelName}</span>
          </div>

          <div className="chat-messages-scroll">
            {messages.length === 0 ? (
              <div className="chat-empty-state">
                <span>💬</span>
                <p>No messages yet.</p>
                <small>Send a real-time message to everyone in #{channelName}.</small>
              </div>
            ) : (
              messages.map((m) => (
                <div
                  key={m.id}
                  className={`chat-bubble-row ${m.isSystem ? 'system' : m.isMe ? 'outgoing' : 'incoming'}`}
                >
                  {m.isSystem ? (
                    <div className="system-message">{m.text}</div>
                  ) : (
                    <div className={`chat-bubble ${m.isMe ? 'me' : 'them'}`}>
                      <div className="bubble-meta">
                        <span className="bubble-sender">{m.sender}</span>
                        <span className="bubble-time">{m.timestamp}</span>
                      </div>
                      <div className="bubble-text">{m.text}</div>
                    </div>
                  )}
                </div>
              ))
            )}
            <div ref={chatBottomRef} />
          </div>

          <form className="chat-input-form" onSubmit={handleSendMessage}>
            <input
              type="text"
              value={messageInput}
              disabled={!isConnected}
              onChange={(e) => setMessageInput(e.target.value)}
              placeholder={isConnected ? 'Type a real-time message...' : 'Join session to chat...'}
            />
            <button
              type="submit"
              disabled={!isConnected || !messageInput.trim()}
              className="btn-send-chat"
            >
              Send 🚀
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
