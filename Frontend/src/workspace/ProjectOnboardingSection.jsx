import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listOnboardings, regenerateOnboardingContext } from '../api/onboarding';
import { formatDate } from './utils';
import { Badge, Icon } from './ui';
import OnboardingModal from './OnboardingModal';
import './onboarding.css';

export default function ProjectOnboardingSection({ projectId, projectName, isOwner }) {
  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    if (!isOwner) return;
    const controller = new AbortController();
    setLoading(true);

    listOnboardings(projectId, controller.signal)
      .then((data) => {
        setAssignments(data?.assignments || []);
        setLoading(false);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          setError(err.message || 'Failed to load onboarding assignments.');
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [projectId, isOwner]);

  async function handleRegenerate(onboardingId) {
    if (busyId) return;
    setBusyId(onboardingId);
    setError('');

    try {
      const res = await regenerateOnboardingContext(projectId, onboardingId);
      setAssignments((prev) =>
        prev.map((item) => (item.id === onboardingId ? res.assignment : item))
      );
    } catch (err) {
      setError(err.message || 'Failed to regenerate context.');
    } finally {
      setBusyId(null);
    }
  }

  function handleCreated(newAssignment) {
    setAssignments((prev) => [newAssignment, ...prev.filter((a) => a.id !== newAssignment.id)]);
  }

  if (!isOwner) return null;

  return (
    <section className="ws-panel ws-onboarding-panel" aria-labelledby="project-onboarding">
      <div className="ws-section-heading">
        <div>
          <h2 id="project-onboarding">
            Member Onboarding <span className="ws-count">{assignments.length}</span>
          </h2>
          <p>
            Structure newcomer briefings, hand off relevant documentation, and track onboarding progress.
          </p>
        </div>
        <div className="ws-onboarding-header-actions">
          <Link className="ws-button" to={`/projects/${projectId}/onboarding`}>
            <Icon name="eye" size={15} />
            View Experience
          </Link>
          <button
            type="button"
            className="ws-button ws-button-primary"
            onClick={() => setShowModal(true)}
          >
            <Icon name="plus" size={16} />
            Onboard Teammate
          </button>
        </div>
      </div>

      {error && <p className="ws-error" role="alert">{error}</p>}

      {loading ? (
        <div className="ws-skeleton ws-skeleton-list" role="status" aria-label="Loading onboarding records" />
      ) : assignments.length === 0 ? (
        <p className="ws-panel-empty">
          No active onboarding assignments yet. Click <strong>Onboard Teammate</strong> to share key documents and an AI-generated briefing with a new member.
        </p>
      ) : (
        <div className="ws-onboarding-assignment-list">
          {assignments.map((assignment) => {
            const reviewedCount = assignment.reviewedSections?.length || 0;
            const docCount = assignment.selectedDocuments?.length || assignment.selectedDocumentCount || 0;
            const isRegenerating = busyId === assignment.id;

            return (
              <div key={assignment.id} className="ws-onboarding-assignment-card">
                <div className="ws-onboarding-user-info">
                  <span className="ws-user-avatar">
                    {assignment.email.charAt(0).toUpperCase()}
                  </span>
                  <div className="ws-onboarding-user-meta">
                    <strong>{assignment.email}</strong>
                    <small>
                      {assignment.role} · {docCount} document(s) assigned · Created {formatDate(assignment.createdAt)}
                    </small>
                  </div>
                </div>

                <div className="ws-onboarding-badges">
                  <span className={`ws-badge-status ${assignment.status}`}>
                    {assignment.status.replace('_', ' ')}
                  </span>
                  <span className="ws-badge" title="Reviewed sections count">
                    {reviewedCount} / 10 reviewed
                  </span>
                </div>

                <div className="ws-onboarding-actions">
                  <Link
                    to={`/projects/${projectId}/onboarding`}
                    className="ws-text-button"
                  >
                    Open View
                  </Link>
                  <button
                    type="button"
                    className="ws-text-button"
                    disabled={isRegenerating}
                    onClick={() => handleRegenerate(assignment.id)}
                  >
                    {isRegenerating ? 'Regenerating…' : 'Regen AI Context'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <OnboardingModal
          projectId={projectId}
          projectName={projectName}
          onClose={() => setShowModal(false)}
          onCreated={handleCreated}
        />
      )}
    </section>
  );
}
