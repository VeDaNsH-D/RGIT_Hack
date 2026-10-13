import { useEffect } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import LandingPage from './pages/LandingPage'
import AuthPage from './components/AuthPage'
import OAuthCallbackPage from './pages/OAuthCallbackPage'
import WorkspaceLayout from './workspace/WorkspaceLayout'
import { DashboardPage, ProjectsPage, ProjectDetailPage, TasksPage, HandoffsPage } from './workspace/WorkspacePages'
import ConnectionsPage from './workspace/ConnectionsPage'
import HandoffDetailPage from './workspace/HandoffDetailPage'
import SettingsPage from './workspace/SettingsPage'
import EmailsPage from './workspace/EmailsPage'
import InvitationPage from './pages/InvitationPage'
import McpAuthorizePage from './workspace/McpAuthorizePage'
import { AgoraRoom } from './components/AgoraRoom'
import CallsPage from './workspace/CallsPage'
import MemberOnboardingPage from './workspace/MemberOnboardingPage'
import './App.css'


function HomeRoute() {
  const { hash } = useLocation();
  // Preserve links shared before path-based routing was introduced.
  if (hash === '#signup') return <Navigate to="/signup" replace />;
  if (hash === '#signin') return <Navigate to="/signin" replace />;
  return <LandingPage />;
}

function ScrollToDestination() {
  const { pathname, hash } = useLocation();

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const target = hash && document.getElementById(decodeURIComponent(hash.slice(1)));
      if (target) target.scrollIntoView();
      else window.scrollTo(0, 0);
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname, hash]);

  return null;
}

function NotFoundPage() {
  return (
    <main className="not-found-page">
      <span className="eyebrow">404 / PAGE NOT FOUND</span>
      <h1>This page isn’t here.</h1>
      <p>Head back to the home page to find what you need.</p>
      <Link className="button button-blue button-orange" to="/">Back to home</Link>
    </main>
  );
}

export default function App() {
  return (
    <>
      <ScrollToDestination />
      <Routes>
        <Route path="/" element={<HomeRoute />} />
        <Route path="/signup" element={<AuthPage key="register" mode="register" />} />
        <Route path="/signin" element={<AuthPage key="login" mode="login" />} />
        <Route path="/login" element={<Navigate to="/signin" replace />} />
        <Route path="/register" element={<Navigate to="/signup" replace />} />
        <Route path="/auth" element={<Navigate to="/signup" replace />} />
        <Route path="/auth/callback" element={<OAuthCallbackPage />} />
        <Route path="/invite" element={<InvitationPage />} />
        <Route element={<WorkspaceLayout />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
          <Route path="/projects/:projectId/onboarding" element={<MemberOnboardingPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/emails" element={<EmailsPage />} />
          <Route path="/handoffs" element={<HandoffsPage />} />
          <Route path="/handoffs/:handoffId" element={<HandoffDetailPage />} />
          <Route path="/connections" element={<ConnectionsPage />} />
          <Route path="/calls" element={<CallsPage />} />
          <Route path="/meet" element={<Navigate to="/calls" replace />} />
          <Route path="/mcp/authorize" element={<McpAuthorizePage />} />
          <Route path="/app" element={<Navigate to="/dashboard" replace />} />
        </Route>

        {/* Agora Real-Time Audio, Video, and Chat Routes */}
        <Route
          path="/agora"
          element={
            <div style={{ minHeight: '100vh', background: '#0a0f1d', padding: '1.5rem 0' }}>
              <AgoraRoom />
            </div>
          }
        />
        <Route
          path="/meet"
          element={
            <div style={{ minHeight: '100vh', background: '#0a0f1d', padding: '1.5rem 0' }}>
              <AgoraRoom />
            </div>
          }
        />
        <Route
          path="/calls"
          element={
            <div style={{ minHeight: '100vh', background: '#0a0f1d', padding: '1.5rem 0' }}>
              <AgoraRoom />
            </div>
          }
        />
        <Route
          path="/chat"
          element={
            <div style={{ minHeight: '100vh', background: '#0a0f1d', padding: '1.5rem 0' }}>
              <AgoraRoom />
            </div>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </>
  );
}
