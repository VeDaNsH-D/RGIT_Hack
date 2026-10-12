import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useWorkspace } from './WorkspaceContext';
import { Icon, PageHeading } from './ui';
import { AgoraRtcManager } from '../services/agoraRtc';
import { AgoraRtmManager } from '../services/agoraRtm';
import { fetchAgoraToken, transcribeAudio, summarizeCall } from '../api/agora';
import './CallsPage.css';

export default function CallsPage() {
  const { session } = useAuth();
  const { projects } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();

  // Lobby & Setup State
  const [channelInput, setChannelInput] = useState(() => searchParams.get('channel') || 'standup-relay');
  const [selectedProjectId, setSelectedProjectId] = useState(() => searchParams.get('project') || '');
  const [callType, setCallType] = useState('video');
  const [inCall, setInCall] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);

  // Pre-call Media Controls (Green room)
  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(true);
  const [lobbyStream, setLobbyStream] = useState(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const lobbyVideoRef = useRef(null);
  const audioContextRef = useRef(null);

  // In-Call Agora State
  const rtcRef = useRef(new AgoraRtcManager());
  const rtmRef = useRef(new AgoraRtmManager());
  const [channelName, setChannelName] = useState('');
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [remoteUsers, setRemoteUsers] = useState([]);
  const [activeSpeaker, setActiveSpeaker] = useState(null);
  const [callDuration, setCallDuration] = useState(0);

  // Video container DOM refs
  const localVideoRef = useRef(null);
  const remoteVideoRefs = useRef(new Map());

  // Meeting Drawer & In-Call Utilities
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [activeTab, setActiveTab] = useState('summary'); // 'summary' | 'chat' | 'people'
  const [copiedLink, setCopiedLink] = useState(false);

  // In-Call Chat (RTM)
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');

  // Transcription & Auto-Summary (Whisper + Groq)
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [liveCaptionText, setLiveCaptionText] = useState('');
  const [transcripts, setTranscripts] = useState([]);
  const [mediaRecorder, setMediaRecorder] = useState(null);
  const [summarizing, setSummarizing] = useState(false);
  const [summaryData, setSummaryData] = useState(null);
  const [pastSummaries, setPastSummaries] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('over2u_recent_summaries') || '[]');
    } catch {
      return [];
    }
  });

  const speechRecognitionRef = useRef(null);

  // 1. Lobby Green Room Camera & Audio Meter Setup
  useEffect(() => {
    let stream = null;
    let animId = null;

    if (!inCall) {
      navigator.mediaDevices?.getUserMedia({ video: true, audio: true })
        .then(s => {
          stream = s;
          setLobbyStream(s);
          if (lobbyVideoRef.current) {
            lobbyVideoRef.current.srcObject = s;
          }

          // Audio meter analyzer
          try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            const ctx = new AudioCtx();
            audioContextRef.current = ctx;
            const source = ctx.createMediaStreamSource(s);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 64;
            source.connect(analyser);
            const dataArray = new Uint8Array(analyser.frequencyBinCount);

            const updateMeter = () => {
              analyser.getByteFrequencyData(dataArray);
              let sum = 0;
              for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
              const avg = sum / dataArray.length;
              setAudioLevel(Math.min(100, Math.round((avg / 128) * 100)));
              animId = requestAnimationFrame(updateMeter);
            };
            updateMeter();
          } catch (e) {
            console.warn('AudioContext meter not supported:', e);
          }
        })
        .catch(err => {
          console.warn('Lobby camera/mic access denied or unavailable:', err.message);
        });
    }

    return () => {
      if (animId) cancelAnimationFrame(animId);
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {});
      }
      if (stream) {
        stream.getTracks().forEach(t => t.stop());
      }
    };
  }, [inCall]);

  // Sync Green room tracks with toggles
  useEffect(() => {
    if (lobbyStream) {
      lobbyStream.getVideoTracks().forEach(t => { t.enabled = camEnabled; });
      lobbyStream.getAudioTracks().forEach(t => { t.enabled = micEnabled; });
    }
  }, [camEnabled, micEnabled, lobbyStream]);

  // Call Duration Timer
  useEffect(() => {
    let timer = null;
    if (inCall) {
      timer = setInterval(() => setCallDuration(d => d + 1), 1000);
    } else {
      setCallDuration(0);
    }
    return () => clearInterval(timer);
  }, [inCall]);

  const formatTimer = (secs) => {
    const mins = Math.floor(secs / 60);
    const s = secs % 60;
    return `${mins.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  // 2. Real-Time Speech Recognition (Live Captions & Transcript Builder)
  const startSpeechRecognition = useCallback(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('SpeechRecognition API not available in this browser.');
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcriptPiece = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            const trimmed = transcriptPiece.trim();
            if (trimmed) {
              const speakerName = session?.user?.name || 'You';
              const newEntry = {
                id: Date.now() + Math.random(),
                speaker: speakerName,
                text: trimmed,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              };
              setTranscripts(prev => [...prev, newEntry]);
              setLiveCaptionText(`${speakerName}: ${trimmed}`);
            }
          } else {
            interim += transcriptPiece;
          }
        }
        if (interim) {
          setLiveCaptionText(`${session?.user?.name || 'You'}: ${interim}`);
        }
      };

      recognition.onerror = (e) => {
        if (e.error !== 'no-speech') {
          console.warn('Speech recognition warning:', e.error);
        }
      };

      recognition.onend = () => {
        // Auto-restart if call is still active and captions enabled
        if (inCall && captionsEnabled) {
          try { recognition.start(); } catch {}
        }
      };

      recognition.start();
      speechRecognitionRef.current = recognition;
    } catch (err) {
      console.warn('Failed starting speech recognition:', err);
    }
  }, [inCall, captionsEnabled, session]);

  // 3. Audio Recording for Groq Whisper Backend Backup
  const startAudioRecorder = useCallback((audioTrack) => {
    try {
      const stream = new MediaStream([audioTrack.getMediaStreamTrack()]);
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      const chunks = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = async () => {
        if (chunks.length > 0) {
          const audioBlob = new Blob(chunks, { type: 'audio/webm' });
          try {
            // Send to Groq Whisper endpoint
            const res = await transcribeAudio(audioBlob);
            if (res?.text?.trim()) {
              setTranscripts(prev => [
                ...prev,
                {
                  id: Date.now(),
                  speaker: session?.user?.name || 'Audio Track',
                  text: res.text.trim(),
                  time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                },
              ]);
            }
          } catch (err) {
            console.warn('Groq Whisper transcription fallback failed:', err.message);
          }
        }
      };

      recorder.start();
      setMediaRecorder(recorder);
    } catch (err) {
      console.warn('MediaRecorder for audio track unavailable:', err.message);
    }
  }, [session]);

  // 4. Join Agora Call (RTC & RTM)
  const handleJoinCall = async () => {
    const targetChannel = (channelInput || 'general-meet').trim();
    if (!targetChannel) return;

    setConnecting(true);
    setError(null);
    setTranscripts([]);
    setLiveCaptionText('');
    setSummaryData(null);

    // Stop lobby green room stream before creating Agora tracks
    if (lobbyStream) {
      lobbyStream.getTracks().forEach(t => t.stop());
      setLobbyStream(null);
    }

    try {
      // 1. Obtain Tokens from Backend
      const tokenRes = await fetchAgoraToken({
        channelName: targetChannel,
        callType,
      });

      const { appId, rtcToken, rtmToken, uid } = tokenRes.data;

      // 2. Join Agora RTC
      const rtcManager = rtcRef.current;
      await rtcManager.join(
        {
          appId,
          channel: targetChannel,
          token: rtcToken,
          uid,
          callType,
        },
        {
          onUserPublished: (user, mediaType) => {
            setRemoteUsers(Array.from(rtcManager.remoteUsers.values()));
            if (mediaType === 'video') {
              setTimeout(() => {
                const el = remoteVideoRefs.current.get(user.uid);
                if (el && user.videoTrack) {
                  user.videoTrack.play(el);
                }
              }, 150);
            }
          },
          onUserUnpublished: (user, mediaType) => {
            setRemoteUsers(Array.from(rtcManager.remoteUsers.values()));
          },
          onUserLeft: (user) => {
            setRemoteUsers(Array.from(rtcManager.remoteUsers.values()));
          },
        }
      );

      // Apply initial mic & cam states
      await rtcManager.setAudioEnabled(micEnabled);
      await rtcManager.setVideoEnabled(camEnabled);

      // Play local video
      if (localVideoRef.current && rtcManager.localVideoTrack) {
        rtcManager.localVideoTrack.play(localVideoRef.current);
      }

      // 3. Connect Agora RTM for In-Call Chat
      const rtmManager = rtmRef.current;
      await rtmManager.login({
        appId,
        userId: String(uid),
        token: rtmToken,
      });

      await rtmManager.joinChannel(targetChannel, {
        onMessage: (msg, senderId) => {
          setChatMessages(prev => [
            ...prev,
            {
              id: Date.now() + Math.random(),
              sender: senderId,
              text: msg,
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            },
          ]);
        },
      });

      // 4. Start Live Captions & Recording
      startSpeechRecognition();
      if (rtcManager.localAudioTrack) {
        startAudioRecorder(rtcManager.localAudioTrack);
      }

      setChannelName(targetChannel);
      setInCall(true);
      setConnecting(false);
    } catch (err) {
      console.error('Failed to join Agora session:', err);
      setError(err.message || 'Could not join call. Please check your network and devices.');
      setConnecting(false);
    }
  };

  // 5. Leave Call & Teardown
  const handleLeaveCall = async () => {
    // Stop speech recognition
    if (speechRecognitionRef.current) {
      try { speechRecognitionRef.current.stop(); } catch {}
      speechRecognitionRef.current = null;
    }

    // Stop recorder
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try { mediaRecorder.stop(); } catch {}
      setMediaRecorder(null);
    }

    // Teardown Agora RTC & RTM
    await rtcRef.current.leave();
    await rtmRef.current.leaveChannel();
    await rtmRef.current.logout();

    setInCall(false);
    setIsScreenSharing(false);
    setRemoteUsers([]);
    setLiveCaptionText('');

    // If summary was generated, save it to recent summaries
    if (summaryData) {
      const updated = [summaryData, ...pastSummaries.slice(0, 9)];
      setPastSummaries(updated);
      try {
        localStorage.setItem('over2u_recent_summaries', JSON.stringify(updated));
      } catch {}
    }
  };

  // Toggle Controls
  const toggleMic = async () => {
    const next = !micEnabled;
    setMicEnabled(next);
    if (inCall) {
      await rtcRef.current.setAudioEnabled(next);
    }
  };

  const toggleCam = async () => {
    const next = !camEnabled;
    setCamEnabled(next);
    if (inCall) {
      await rtcRef.current.setVideoEnabled(next);
      if (next && localVideoRef.current && rtcRef.current.localVideoTrack) {
        rtcRef.current.localVideoTrack.play(localVideoRef.current);
      }
    }
  };

  const toggleScreenShare = async () => {
    const rtc = rtcRef.current;
    if (!isScreenSharing) {
      const track = await rtc.startScreenShare();
      if (track) {
        setIsScreenSharing(true);
        if (localVideoRef.current) {
          track.play(localVideoRef.current);
        }
      }
    } else {
      await rtc.stopScreenShare();
      setIsScreenSharing(false);
      if (camEnabled && localVideoRef.current && rtc.localVideoTrack) {
        rtc.localVideoTrack.play(localVideoRef.current);
      }
    }
  };

  // Send In-Call Chat Message
  const handleSendMessage = async (e) => {
    e?.preventDefault();
    const text = chatInput.trim();
    if (!text || !inCall) return;

    try {
      await rtmRef.current.sendMessage(text);
      setChatMessages(prev => [
        ...prev,
        {
          id: Date.now(),
          sender: session?.user?.name || 'You',
          text,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
      setChatInput('');
    } catch (err) {
      console.warn('Failed sending chat message:', err);
    }
  };

  // 6. Generate Meeting Summary with Groq (Whisper + LLM)
  const handleGenerateSummary = async () => {
    const fullTranscript = transcripts.map(t => `${t.speaker}: ${t.text}`).join('\n');
    if (!fullTranscript.trim()) {
      alert('No speech detected yet to summarize. Please speak during the call or enable live captions.');
      return;
    }

    setSummarizing(true);
    try {
      const participants = [session?.user?.name || 'Host', ...remoteUsers.map(u => `User ${u.uid}`)];
      const res = await summarizeCall({
        transcript: fullTranscript,
        channelName,
        duration: formatTimer(callDuration),
        participants,
      });

      if (res?.data) {
        setSummaryData(res.data);
        setActiveTab('summary');
        // Cache to recent summaries
        const updated = [res.data, ...pastSummaries.filter(s => s.channelName !== channelName).slice(0, 9)];
        setPastSummaries(updated);
        try {
          localStorage.setItem('over2u_recent_summaries', JSON.stringify(updated));
        } catch {}
      }
    } catch (err) {
      console.error('Groq summarization failed:', err);
      alert(err.message || 'Failed to generate summary with Groq.');
    } finally {
      setSummarizing(false);
    }
  };

  const copyInviteLink = () => {
    const url = `${window.location.origin}/calls?channel=${encodeURIComponent(channelName || channelInput)}`;
    navigator.clipboard?.writeText(url);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const startInstantMeeting = () => {
    const code = `meet-${Math.random().toString(36).substring(2, 8)}`;
    setChannelInput(code);
    setTimeout(() => handleJoinCall(), 50);
  };

  // --- RENDER ---
  return (
    <div className="ws-calls-container">
      {!inCall ? (
        /* --- LOBBY STATE --- */
        <>
          <PageHeading
            eyebrow="REAL-TIME COLLABORATION"
            title="Calls & Standups"
            description="High-definition audio and video meetings with real-time live captions and automatic meeting summaries powered by Whisper and Groq."
            action="Instant Meeting"
            onAction={startInstantMeeting}
          />

          {error && <div className="ws-error-panel" role="alert"><p>{error}</p></div>}

          <div className="ws-calls-lobby">
            {/* Left Card: Join Details & Project Standups */}
            <div className="ws-lobby-card">
              <h2>Ready to join?</h2>
              <p>Enter a meeting code or pick a project to start a quick team standup.</p>

              <div className="ws-lobby-field">
                <label>Meeting Code or Topic</label>
                <input
                  type="text"
                  className="ws-lobby-input"
                  placeholder="e.g. standup-core or project-alpha"
                  value={channelInput}
                  onChange={(e) => setChannelInput(e.target.value)}
                />
              </div>

              {projects.length > 0 && (
                <div className="ws-lobby-field">
                  <label>Or Link to a Project</label>
                  <select
                    className="ws-lobby-input"
                    value={selectedProjectId}
                    onChange={(e) => {
                      setSelectedProjectId(e.target.value);
                      if (e.target.value) {
                        const p = projects.find(proj => proj.id === e.target.value);
                        if (p) setChannelInput(`project-${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
                      }
                    }}
                  >
                    <option value="">Select a project for standup sync…</option>
                    {projects.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="ws-lobby-field">
                <label>Call Mode</label>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button
                    className={`ws-button ${callType === 'video' ? 'ws-button-primary' : ''}`}
                    onClick={() => setCallType('video')}
                    style={{ flex: 1 }}
                  >
                    <Icon name="camera" size={16} /> Video Call
                  </button>
                  <button
                    className={`ws-button ${callType === 'audio' ? 'ws-button-primary' : ''}`}
                    onClick={() => setCallType('audio')}
                    style={{ flex: 1 }}
                  >
                    <Icon name="mic" size={16} /> Audio Only
                  </button>
                </div>
              </div>

              <div className="ws-lobby-actions">
                <button
                  className="ws-button ws-button-primary"
                  onClick={handleJoinCall}
                  disabled={connecting || !channelInput.trim()}
                  style={{ height: '44px', fontSize: '13px', fontWeight: 600 }}
                >
                  {connecting ? 'Connecting to Room…' : 'Join Call'}
                </button>
              </div>
            </div>

            {/* Right Card: Green Room Device Preview */}
            <div className="ws-lobby-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2>Camera & Mic Check</h2>
                <div className="ws-audio-meter-bar" title="Mic activity">
                  <span style={{ height: `${Math.max(4, audioLevel * 0.2)}px` }} />
                  <span style={{ height: `${Math.max(4, audioLevel * 0.35)}px` }} />
                  <span style={{ height: `${Math.max(4, audioLevel * 0.15)}px` }} />
                </div>
              </div>

              <div className="ws-green-room">
                {camEnabled ? (
                  <video ref={lobbyVideoRef} autoPlay playsInline muted />
                ) : (
                  <div className="ws-green-room-avatar">
                    <span>{session?.user?.name ? session.user.name.charAt(0).toUpperCase() : 'U'}</span>
                    <p>Camera is turned off</p>
                  </div>
                )}

                <div className="ws-green-room-controls">
                  <button
                    className={`ws-icon-toggle ${!micEnabled ? 'off' : ''}`}
                    onClick={toggleMic}
                    title={micEnabled ? 'Mute microphone' : 'Unmute microphone'}
                  >
                    <Icon name={micEnabled ? 'mic' : 'micOff'} size={18} />
                  </button>
                  <button
                    className={`ws-icon-toggle ${!camEnabled ? 'off' : ''}`}
                    onClick={toggleCam}
                    title={camEnabled ? 'Turn off camera' : 'Turn on camera'}
                  >
                    <Icon name={camEnabled ? 'camera' : 'cameraOff'} size={18} />
                  </button>
                </div>
              </div>

              <p style={{ fontSize: '11px', textAlign: 'center', margin: 0 }}>
                {micEnabled ? 'Microphone is active.' : 'Microphone is muted.'}
                {' '}
                {camEnabled ? 'Camera preview on.' : 'Camera is off.'}
              </p>
            </div>
          </div>

          {/* Past Meeting Summaries Section */}
          {pastSummaries.length > 0 && (
            <div className="ws-past-summaries">
              <div className="ws-section-heading">
                <div>
                  <h2>Recent Meeting Summaries</h2>
                  <p>AI auto-synthesized summaries from your team's calls.</p>
                </div>
              </div>

              <div className="ws-dashboard-columns">
                {pastSummaries.slice(0, 3).map((summary, idx) => (
                  <article key={idx} className="ws-past-summary-card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span className="ws-badge ws-badge-completed">Groq Summary</span>
                      <small className="ws-muted">{new Date(summary.generatedAt || Date.now()).toLocaleDateString()}</small>
                    </div>
                    <h3>{summary.channelName}</h3>
                    <p style={{ fontSize: '12px', color: 'var(--ws-muted)', lineHeight: 1.5 }}>
                      {summary.overview}
                    </p>
                    {summary.actionItems?.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' }}>
                        <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--ws-ink)' }}>Action items:</span>
                        {summary.actionItems.slice(0, 2).map((item, i) => (
                          <div key={i} className="ws-action-item">
                            <span>• {item.task}</span>
                            {item.assignee && <small>({item.assignee})</small>}
                          </div>
                        ))}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        /* --- IN-CALL GOOGLE MEET STAGE --- */
        <div className="ws-meet-stage">
          {/* Top Bar */}
          <header className="ws-meet-header">
            <div className="ws-meet-header-left">
              <span className="ws-meet-badge">Over2u Meet</span>
              <div className="ws-meet-code">
                <strong>{channelName}</strong>
                <button
                  className="ws-text-button"
                  style={{ color: '#fff', padding: '2px 6px', fontSize: '11px' }}
                  onClick={copyInviteLink}
                >
                  <Icon name="copy" size={13} /> {copiedLink ? 'Copied link!' : 'Copy link'}
                </button>
              </div>
              <span className="ws-meet-timer">{formatTimer(callDuration)}</span>
            </div>

            <div className="ws-meet-header-right">
              {captionsEnabled && (
                <div className="ws-meet-recording-pill">
                  <span className="ws-pulse-dot" /> Live Transcribing
                </div>
              )}
              <span className="ws-meet-badge">
                <Icon name="users" size={13} /> {remoteUsers.length + 1}
              </span>
            </div>
          </header>

          {/* Main Body: Video Grid + Side Drawer */}
          <div className="ws-meet-body">
            {/* Center Video Grid */}
            <div className={`ws-meet-grid ${remoteUsers.length === 0 ? 'single' : remoteUsers.length === 1 ? 'duo' : ''}`}>
              {/* Local Participant Tile */}
              <div className={`ws-video-tile local ${activeSpeaker === 'local' ? 'speaking' : ''}`}>
                {camEnabled ? (
                  <div ref={localVideoRef} style={{ width: '100%', height: '100%' }} />
                ) : (
                  <div className="ws-tile-avatar">
                    <div className="ws-tile-avatar-circle">
                      {session?.user?.name ? session.user.name.charAt(0).toUpperCase() : 'U'}
                    </div>
                  </div>
                )}
                <div className="ws-tile-info-pill">
                  <span>{session?.user?.name || 'You'} (You)</span>
                  <span className={`ws-tile-mic-indicator ${!micEnabled ? 'muted' : ''}`}>
                    <Icon name={micEnabled ? 'mic' : 'micOff'} size={12} />
                  </span>
                </div>
              </div>

              {/* Remote Participants Tiles */}
              {remoteUsers.map(user => (
                <div key={user.uid} className="ws-video-tile">
                  <div
                    ref={el => {
                      if (el) {
                        remoteVideoRefs.current.set(user.uid, el);
                        if (user.videoTrack) user.videoTrack.play(el);
                      } else {
                        remoteVideoRefs.current.delete(user.uid);
                      }
                    }}
                    style={{ width: '100%', height: '100%' }}
                  />
                  {!user.hasVideo && (
                    <div className="ws-tile-avatar">
                      <div className="ws-tile-avatar-circle">
                        {String(user.uid).charAt(0).toUpperCase()}
                      </div>
                    </div>
                  )}
                  <div className="ws-tile-info-pill">
                    <span>Teammate {user.uid}</span>
                    <span className={`ws-tile-mic-indicator ${!user.hasAudio ? 'muted' : ''}`}>
                      <Icon name={user.hasAudio ? 'mic' : 'micOff'} size={12} />
                    </span>
                  </div>
                </div>
              ))}

              {/* Live Floating Captions on Screen */}
              {captionsEnabled && liveCaptionText && (
                <div className="ws-live-captions-overlay">
                  {liveCaptionText}
                </div>
              )}
            </div>

            {/* Google Meet Right Drawer (Transcripts, Summary, Chat) */}
            {drawerOpen && (
              <aside className="ws-meet-drawer">
                <div className="ws-drawer-tabs">
                  <button
                    className={`ws-drawer-tab ${activeTab === 'summary' ? 'active' : ''}`}
                    onClick={() => setActiveTab('summary')}
                  >
                    AI Summary & Notes
                  </button>
                  <button
                    className={`ws-drawer-tab ${activeTab === 'chat' ? 'active' : ''}`}
                    onClick={() => setActiveTab('chat')}
                  >
                    Chat ({chatMessages.length})
                  </button>
                  <button
                    className={`ws-drawer-tab ${activeTab === 'people' ? 'active' : ''}`}
                    onClick={() => setActiveTab('people')}
                  >
                    People ({remoteUsers.length + 1})
                  </button>
                </div>

                <div className="ws-drawer-content">
                  {/* Tab 1: AI Summary & Live Transcript */}
                  {activeTab === 'summary' && (
                    <>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: '11px', fontWeight: 600, color: '#d1c7be', letterSpacing: '0.04em' }}>
                          LIVE TRANSCRIPT ({transcripts.length})
                        </span>
                        <button
                          className="ws-button ws-button-primary"
                          style={{ padding: '6px 10px', fontSize: '11px', minHeight: '30px' }}
                          onClick={handleGenerateSummary}
                          disabled={summarizing || transcripts.length === 0}
                        >
                          <Icon name="sparkles" size={13} />
                          {summarizing ? 'Generating…' : 'Generate Summary'}
                        </button>
                      </div>

                      <div className="ws-transcript-box">
                        {transcripts.length === 0 ? (
                          <div className="ws-transcript-empty">
                            Start speaking to see real-time transcription. Whisper & Groq are listening.
                          </div>
                        ) : (
                          transcripts.map(t => (
                            <div key={t.id} className="ws-transcript-item">
                              <div className="ws-transcript-item-header">
                                <span>{t.speaker}</span>
                                <span className="ws-transcript-item-time">{t.time}</span>
                              </div>
                              <span className="ws-transcript-item-text">{t.text}</span>
                            </div>
                          ))
                        )}
                      </div>

                      {/* AI Generated Meeting Summary */}
                      {summaryData && (
                        <div className="ws-summary-card">
                          <div className="ws-summary-header">
                            <h4><Icon name="sparkles" size={15} /> Meeting Summary</h4>
                            <span>Groq AI</span>
                          </div>

                          <div className="ws-summary-section">
                            <span className="ws-summary-section-title">Overview</span>
                            <p className="ws-summary-text">{summaryData.overview}</p>
                          </div>

                          {summaryData.keyPoints?.length > 0 && (
                            <div className="ws-summary-section">
                              <span className="ws-summary-section-title">Key Points</span>
                              <ul className="ws-summary-list">
                                {summaryData.keyPoints.map((pt, i) => (
                                  <li key={i}>{pt}</li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {summaryData.decisions?.length > 0 && (
                            <div className="ws-summary-section">
                              <span className="ws-summary-section-title">Decisions</span>
                              <ul className="ws-summary-list">
                                {summaryData.decisions.map((dec, i) => (
                                  <li key={i}>{dec}</li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {summaryData.actionItems?.length > 0 && (
                            <div className="ws-summary-section">
                              <span className="ws-summary-section-title">Action Items</span>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                {summaryData.actionItems.map((item, i) => (
                                  <div key={i} className="ws-action-item">
                                    <input type="checkbox" id={`task-${i}`} />
                                    <label htmlFor={`task-${i}`}>{item.task}</label>
                                    {item.assignee && <small>{item.assignee}</small>}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          <div className="ws-summary-actions">
                            <button
                              className="ws-button"
                              style={{ flex: 1, padding: '7px 10px', fontSize: '11px', minHeight: '32px' }}
                              onClick={() => {
                                navigator.clipboard?.writeText(summaryData.rawMarkdown || summaryData.overview);
                                alert('Summary copied to clipboard!');
                              }}
                            >
                              <Icon name="copy" size={13} /> Copy Notes
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {/* Tab 2: In-Call Chat */}
                  {activeTab === 'chat' && (
                    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                      <div className="ws-chat-messages">
                        {chatMessages.length === 0 ? (
                          <div className="ws-transcript-empty">No messages yet. Send a chat to the room.</div>
                        ) : (
                          chatMessages.map(msg => (
                            <div key={msg.id} className="ws-chat-bubble">
                              <strong>{msg.sender} · {msg.time}</strong>
                              <span>{msg.text}</span>
                            </div>
                          ))
                        )}
                      </div>

                      <form onSubmit={handleSendMessage} className="ws-chat-input-bar">
                        <input
                          type="text"
                          className="ws-chat-input"
                          placeholder="Send message to everyone…"
                          value={chatInput}
                          onChange={(e) => setChatInput(e.target.value)}
                        />
                        <button type="submit" className="ws-button ws-button-primary" style={{ minHeight: '34px', padding: '0 12px' }}>
                          Send
                        </button>
                      </form>
                    </div>
                  )}

                  {/* Tab 3: People */}
                  {activeTab === 'people' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      <div className="ws-action-item" style={{ background: 'rgba(255,255,255,0.06)' }}>
                        <Icon name="users" size={14} />
                        <span>{session?.user?.name || 'You'} (Host)</span>
                        <small>{micEnabled ? 'Mic on' : 'Muted'}</small>
                      </div>
                      {remoteUsers.map(u => (
                        <div key={u.uid} className="ws-action-item">
                          <Icon name="users" size={14} />
                          <span>Teammate {u.uid}</span>
                          <small>{u.hasAudio ? 'Mic on' : 'Muted'}</small>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </aside>
            )}
          </div>

          {/* Bottom Toolbar (Google Meet Style) */}
          <footer className="ws-meet-toolbar">
            <button
              className={`ws-meet-btn ${!micEnabled ? 'off' : ''}`}
              onClick={toggleMic}
              title={micEnabled ? 'Turn off microphone' : 'Turn on microphone'}
            >
              <Icon name={micEnabled ? 'mic' : 'micOff'} size={20} />
            </button>

            <button
              className={`ws-meet-btn ${!camEnabled ? 'off' : ''}`}
              onClick={toggleCam}
              title={camEnabled ? 'Turn off camera' : 'Turn on camera'}
            >
              <Icon name={camEnabled ? 'camera' : 'cameraOff'} size={20} />
            </button>

            <button
              className={`ws-meet-btn ${isScreenSharing ? 'active' : ''}`}
              onClick={toggleScreenShare}
              title={isScreenSharing ? 'Stop sharing screen' : 'Share entire screen'}
            >
              <Icon name="screenShare" size={20} />
            </button>

            <button
              className={`ws-meet-btn ${captionsEnabled ? 'active' : ''}`}
              onClick={() => setCaptionsEnabled(!captionsEnabled)}
              title={captionsEnabled ? 'Turn off live captions' : 'Turn on live captions'}
            >
              <Icon name="captions" size={20} />
            </button>

            <button
              className={`ws-meet-btn ${drawerOpen && activeTab === 'summary' ? 'active' : ''}`}
              onClick={() => {
                setDrawerOpen(true);
                setActiveTab('summary');
              }}
              title="Meeting Auto-Summary (Groq AI)"
            >
              <Icon name="sparkles" size={20} />
            </button>

            <button
              className={`ws-meet-btn ${drawerOpen && activeTab === 'chat' ? 'active' : ''}`}
              onClick={() => {
                if (drawerOpen && activeTab === 'chat') {
                  setDrawerOpen(false);
                } else {
                  setDrawerOpen(true);
                  setActiveTab('chat');
                }
              }}
              title="In-call chat"
            >
              <Icon name="chat" size={20} />
            </button>

            <button
              className={`ws-meet-btn ${drawerOpen && activeTab === 'people' ? 'active' : ''}`}
              onClick={() => {
                if (drawerOpen && activeTab === 'people') {
                  setDrawerOpen(false);
                } else {
                  setDrawerOpen(true);
                  setActiveTab('people');
                }
              }}
              title="Participants"
            >
              <Icon name="users" size={20} />
            </button>

            <button
              className="ws-meet-btn end-call"
              onClick={handleLeaveCall}
              title="Leave call"
            >
              <Icon name="endCall" size={22} />
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}
