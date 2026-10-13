import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useWorkspace } from './WorkspaceContext';
import {
  getMyOnboarding,
  getOnboardingDocuments,
  getOnboardingDocumentPreview,
  downloadOnboardingDocument,
  reviewOnboardingSection,
  completeOnboarding,
} from '../api/onboarding';
import { formatDate } from './utils';
import { formatBytes } from './documentHelpers';
import { Badge, Icon } from './ui';
import './onboarding.css';

const SECTIONS = [
  { key: 'overview', title: '1. What This Project Does', desc: 'Core purpose, architecture, and technology stack' },
  { key: 'status', title: '2. Current Project Status', desc: 'Active phase, milestones, and operational rhythm' },
  { key: 'completed_work', title: '3. Completed Work & Deliverables', desc: 'Milestones already confirmed and achieved' },
  { key: 'decisions', title: '4. Key Decisions & Rationale', desc: 'Architectural and procedural choices with recorded motivations' },
  { key: 'troubleshooting', title: '5. Previous Troubleshooting & Outcomes', desc: 'Actions attempted and failure outcomes to avoid repeated mistakes' },
  { key: 'blockers', title: '6. Blockers & Unresolved Issues', desc: 'Impediments currently preventing forward movement' },
  { key: 'tasks', title: '7. Pending Tasks & Deadlines', desc: 'Next priorities, owners, and due dates' },
  { key: 'next_steps', title: '8. Recommended Next Steps', desc: 'Suggested starting actions for your first week' },
  { key: 'missing_info', title: '9. Missing Information & Knowledge Gaps', desc: 'Questions requiring clarification or missing context' },
  { key: 'documents', title: '10. Assigned Project Documents', desc: 'Selected documentation and reference manuals' },
];

export default function MemberOnboardingPage() {
  const { projectId } = useParams();
  const { session } = useAuth();
  const { projects } = useWorkspace();
  const navigate = useNavigate();

  const [assignment, setAssignment] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [previewDoc, setPreviewDoc] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const project = projects.find((p) => p.id === projectId);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');

    getMyOnboarding(projectId, controller.signal)
      .then((data) => {
        setAssignment(data.assignment);
        if (data.assignment?.id) {
          return getOnboardingDocuments(projectId, data.assignment.id, controller.signal);
        }
        return { documents: [] };
      })
      .then((docsData) => {
        setDocuments(docsData?.documents || []);
        setLoading(false);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          setError(err.message || 'Unable to load your onboarding briefing.');
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [projectId]);

  const reviewedSections = assignment?.reviewedSections || [];
  const progressPercent = Math.round((reviewedSections.length / SECTIONS.length) * 100);
  const isCompleted = assignment?.status === 'completed';

  async function handleAcknowledge(sectionKey) {
    if (!assignment?.id || busy) return;
    const isAlreadyReviewed = reviewedSections.includes(sectionKey);
    const updatedSections = isAlreadyReviewed
      ? reviewedSections.filter((k) => k !== sectionKey)
      : [...reviewedSections, sectionKey];

    // Optimistic update
    setAssignment((prev) => ({
      ...prev,
      reviewedSections: updatedSections,
      status: prev.status === 'ready' ? 'in_progress' : prev.status,
    }));

    try {
      await reviewOnboardingSection(projectId, assignment.id, {
        section: sectionKey,
      });
    } catch (err) {
      console.warn('Review acknowledge sync failed:', err.message);
    }
  }

  async function handleComplete() {
    if (!assignment?.id || busy) return;
    setBusy(true);
    setError('');

    try {
      const res = await completeOnboarding(projectId, assignment.id);
      setAssignment(res.assignment);
    } catch (err) {
      setError(err.message || 'Failed to complete onboarding.');
    } finally {
      setBusy(false);
    }
  }

  async function handlePreview(docId) {
    if (!assignment?.id) return;
    setPreviewLoading(true);
    try {
      const data = await getOnboardingDocumentPreview(projectId, assignment.id, docId);
      setPreviewDoc(data);
    } catch (err) {
      setError(err.message || 'Failed to preview document.');
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleDownload(docId, filename) {
    if (!assignment?.id) return;
    try {
      await downloadOnboardingDocument(projectId, assignment.id, docId, filename);
    } catch (err) {
      setError(err.message || 'Download failed.');
    }
  }

  if (loading) {
    return (
      <div className="ws-member-onboarding-page">
        <p className="ws-muted">Loading your onboarding briefing…</p>
      </div>
    );
  }

  if (error && !assignment) {
    return (
      <div className="ws-member-onboarding-page">
        <div className="ws-panel">
          <h2>Onboarding unavailable</h2>
          <p className="ws-muted">{error}</p>
          <Link to={`/projects/${projectId}`} className="button button-blue button-orange">
            Go to Project Overview
          </Link>
        </div>
      </div>
    );
  }

  const cp = assignment?.contextPack || {};

  return (
    <div className="ws-member-onboarding-page">
      <Link to={`/projects/${projectId}`} className="ws-back-link">
        ← Back to {project?.name || 'Project'}
      </Link>

      {/* Hero Welcome Banner */}
      <section className="ws-onboarding-hero">
        <span className="ws-eyebrow">PROJECT ONBOARDING & CONTINUITY</span>
        <h1>Welcome to {project?.name || 'the project'}. Here’s the context you need to get started.</h1>
        <p>
          You’ve been assigned as a <strong>{assignment?.role || 'team member'}</strong>. Review the synthesized briefing and assigned documents below so you can hit the ground running with zero guesswork.
        </p>

        <div>
          <div className="ws-onboarding-progress-bar-container">
            <div
              className="ws-onboarding-progress-fill"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <div className="ws-onboarding-progress-stats">
            <span>
              {reviewedSections.length} of {SECTIONS.length} sections reviewed
            </span>
            <span>{progressPercent}% Complete</span>
          </div>
        </div>
      </section>

      {isCompleted && (
        <div className="ws-onboarding-success-banner">
          <div>
            <strong style={{ fontSize: 15, display: 'block' }}>
              ✓ Onboarding Complete!
            </strong>
            <span style={{ fontSize: 13 }}>
              Completed on {formatDate(assignment.completedAt)}. You have reviewed the essential context for this workspace.
            </span>
          </div>
          <Link to={`/projects/${projectId}`} className="ws-button ws-button-primary">
            Enter Workspace →
          </Link>
        </div>
      )}

      {error && <p className="ws-error" role="alert">{error}</p>}

      <div className="ws-onboarding-grid">
        {/* Section 1: Overview & Stack */}
        <div className={`ws-onboarding-section ${reviewedSections.includes('overview') ? 'is-reviewed' : ''}`}>
          <div className="ws-onboarding-section-header">
            <div className="ws-onboarding-section-title">
              <span className="ws-onboarding-section-num">1</span>
              <div>
                <h2>What This Project Does</h2>
                <small className="ws-muted">Core purpose and technology ecosystem</small>
              </div>
            </div>
            <button
              type="button"
              className={`ws-onboarding-ack-btn ${reviewedSections.includes('overview') ? 'checked' : ''}`}
              onClick={() => handleAcknowledge('overview')}
            >
              {reviewedSections.includes('overview') ? '✓ Reviewed' : 'Mark as Reviewed'}
            </button>
          </div>
          <p style={{ margin: '0 0 12px 0', fontSize: 14, lineHeight: 1.5, color: '#334155' }}>
            {cp.projectOverview || project?.description || 'No detailed overview generated yet.'}
          </p>
          {cp.technologyStack?.length > 0 && (
            <div>
              <strong style={{ fontSize: 12, color: '#64748b', textTransform: 'uppercase' }}>
                Detected Technology Stack:
              </strong>
              <div className="ws-tech-pill-list">
                {cp.technologyStack.map((tech) => (
                  <span key={tech} className="ws-tech-pill">
                    {tech}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Section 2: Current Status */}
        <div className={`ws-onboarding-section ${reviewedSections.includes('status') ? 'is-reviewed' : ''}`}>
          <div className="ws-onboarding-section-header">
            <div className="ws-onboarding-section-title">
              <span className="ws-onboarding-section-num">2</span>
              <div>
                <h2>Current Project Status</h2>
                <small className="ws-muted">Current phase and focus</small>
              </div>
            </div>
            <button
              type="button"
              className={`ws-onboarding-ack-btn ${reviewedSections.includes('status') ? 'checked' : ''}`}
              onClick={() => handleAcknowledge('status')}
            >
              {reviewedSections.includes('status') ? '✓ Reviewed' : 'Mark as Reviewed'}
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="ws-badge ws-badge-status ready">
              {cp.currentStatus || 'Active Development'}
            </span>
            <span style={{ fontSize: 13, color: '#475569' }}>
              {cp.summary || 'Project is under active development.'}
            </span>
          </div>
        </div>

        {/* Section 3: Completed Work */}
        <div className={`ws-onboarding-section ${reviewedSections.includes('completed_work') ? 'is-reviewed' : ''}`}>
          <div className="ws-onboarding-section-header">
            <div className="ws-onboarding-section-title">
              <span className="ws-onboarding-section-num">3</span>
              <div>
                <h2>Completed Work & Deliverables</h2>
                <small className="ws-muted">Confirmed progress so you do not rebuild existing work</small>
              </div>
            </div>
            <button
              type="button"
              className={`ws-onboarding-ack-btn ${reviewedSections.includes('completed_work') ? 'checked' : ''}`}
              onClick={() => handleAcknowledge('completed_work')}
            >
              {reviewedSections.includes('completed_work') ? '✓ Reviewed' : 'Mark as Reviewed'}
            </button>
          </div>
          {cp.completedWork?.length > 0 ? (
            <ul style={{ margin: 0, paddingLeft: 20, color: '#334155', fontSize: 13, lineHeight: 1.6 }}>
              {cp.completedWork.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          ) : (
            <p className="ws-panel-empty">No completed work logged yet.</p>
          )}
        </div>

        {/* Section 4: Decisions & Rationale */}
        <div className={`ws-onboarding-section ${reviewedSections.includes('decisions') ? 'is-reviewed' : ''}`}>
          <div className="ws-onboarding-section-header">
            <div className="ws-onboarding-section-title">
              <span className="ws-onboarding-section-num">4</span>
              <div>
                <h2>Important Decisions & Rationale</h2>
                <small className="ws-muted">Decisions made and why they were taken</small>
              </div>
            </div>
            <button
              type="button"
              className={`ws-onboarding-ack-btn ${reviewedSections.includes('decisions') ? 'checked' : ''}`}
              onClick={() => handleAcknowledge('decisions')}
            >
              {reviewedSections.includes('decisions') ? '✓ Reviewed' : 'Mark as Reviewed'}
            </button>
          </div>
          {cp.decisions?.length > 0 ? (
            <div className="ws-card-list">
              {cp.decisions.map((d, idx) => (
                <div key={idx} className="ws-card-subitem decision">
                  <strong>{d.decision}</strong>
                  <p>{d.rationale || 'Rationale recorded in project history.'}</p>
                  {d.decided_at && (
                    <small className="ws-muted" style={{ display: 'block', marginTop: 4 }}>
                      Decided: {formatDate(d.decided_at)}
                    </small>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="ws-panel-empty">No architectural decisions recorded yet.</p>
          )}
        </div>

        {/* Section 5: Troubleshooting History */}
        <div className={`ws-onboarding-section ${reviewedSections.includes('troubleshooting') ? 'is-reviewed' : ''}`}>
          <div className="ws-onboarding-section-header">
            <div className="ws-onboarding-section-title">
              <span className="ws-onboarding-section-num">5</span>
              <div>
                <h2>Previous Troubleshooting & Outcomes</h2>
                <small className="ws-muted">Actions already attempted so you do not repeat known dead ends</small>
              </div>
            </div>
            <button
              type="button"
              className={`ws-onboarding-ack-btn ${reviewedSections.includes('troubleshooting') ? 'checked' : ''}`}
              onClick={() => handleAcknowledge('troubleshooting')}
            >
              {reviewedSections.includes('troubleshooting') ? '✓ Reviewed' : 'Mark as Reviewed'}
            </button>
          </div>
          {cp.attemptedActions?.length > 0 ? (
            <div className="ws-card-list">
              {cp.attemptedActions.map((a, idx) => (
                <div key={idx} className="ws-card-subitem attempt">
                  <strong>Attempted: {a.action}</strong>
                  <p>Outcome / Result: {a.outcome}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="ws-panel-empty">No troubleshooting roadblocks logged yet.</p>
          )}
        </div>

        {/* Section 6: Blockers & Risks */}
        <div className={`ws-onboarding-section ${reviewedSections.includes('blockers') ? 'is-reviewed' : ''}`}>
          <div className="ws-onboarding-section-header">
            <div className="ws-onboarding-section-title">
              <span className="ws-onboarding-section-num">6</span>
              <div>
                <h2>Current Blockers & Risks</h2>
                <small className="ws-muted">Active impediments requiring resolution</small>
              </div>
            </div>
            <button
              type="button"
              className={`ws-onboarding-ack-btn ${reviewedSections.includes('blockers') ? 'checked' : ''}`}
              onClick={() => handleAcknowledge('blockers')}
            >
              {reviewedSections.includes('blockers') ? '✓ Reviewed' : 'Mark as Reviewed'}
            </button>
          </div>
          {cp.blockers?.length > 0 ? (
            <div className="ws-card-list">
              {cp.blockers.map((b, idx) => (
                <div key={idx} className="ws-card-subitem blocker">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span className="ws-badge" style={{ background: '#fee2e2', color: '#b91c1c' }}>
                      {b.severity || 'Medium'}
                    </span>
                    <strong>{b.description}</strong>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="ws-panel-empty">No active blockers flagged.</p>
          )}
        </div>

        {/* Section 7: Tasks & Deadlines */}
        <div className={`ws-onboarding-section ${reviewedSections.includes('tasks') ? 'is-reviewed' : ''}`}>
          <div className="ws-onboarding-section-header">
            <div className="ws-onboarding-section-title">
              <span className="ws-onboarding-section-num">7</span>
              <div>
                <h2>Pending Tasks & Deadlines</h2>
                <small className="ws-muted">Confirmed priorities and operational tasks</small>
              </div>
            </div>
            <button
              type="button"
              className={`ws-onboarding-ack-btn ${reviewedSections.includes('tasks') ? 'checked' : ''}`}
              onClick={() => handleAcknowledge('tasks')}
            >
              {reviewedSections.includes('tasks') ? '✓ Reviewed' : 'Mark as Reviewed'}
            </button>
          </div>
          {cp.pendingTasks?.length > 0 ? (
            <div className="ws-card-list">
              {cp.pendingTasks.map((t, idx) => (
                <div key={t.id || idx} className="ws-task-item-compact">
                  <div className="ws-task-item-left">
                    <span className="ws-badge">{t.priority}</span>
                    <strong style={{ fontSize: 13 }}>{t.title}</strong>
                  </div>
                  {t.deadline && (
                    <small className="ws-muted">Due {formatDate(t.deadline)}</small>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="ws-panel-empty">No open tasks currently assigned.</p>
          )}
        </div>

        {/* Section 8: Recommended Next Steps */}
        <div className={`ws-onboarding-section ${reviewedSections.includes('next_steps') ? 'is-reviewed' : ''}`}>
          <div className="ws-onboarding-section-header">
            <div className="ws-onboarding-section-title">
              <span className="ws-onboarding-section-num">8</span>
              <div>
                <h2>Recommended Next Steps</h2>
                <small className="ws-muted">Guided action items for your initial ramp-up</small>
              </div>
            </div>
            <button
              type="button"
              className={`ws-onboarding-ack-btn ${reviewedSections.includes('next_steps') ? 'checked' : ''}`}
              onClick={() => handleAcknowledge('next_steps')}
            >
              {reviewedSections.includes('next_steps') ? '✓ Reviewed' : 'Mark as Reviewed'}
            </button>
          </div>
          {cp.recommendedNextSteps?.length > 0 ? (
            <ol style={{ margin: 0, paddingLeft: 20, color: '#334155', fontSize: 13, lineHeight: 1.6 }}>
              {cp.recommendedNextSteps.map((step, idx) => (
                <li key={idx} style={{ marginBottom: 4 }}>
                  {step}
                </li>
              ))}
            </ol>
          ) : (
            <p className="ws-panel-empty">Review the assigned documentation to begin.</p>
          )}
        </div>

        {/* Section 9: Missing Information */}
        <div className={`ws-onboarding-section ${reviewedSections.includes('missing_info') ? 'is-reviewed' : ''}`}>
          <div className="ws-onboarding-section-header">
            <div className="ws-onboarding-section-title">
              <span className="ws-onboarding-section-num">9</span>
              <div>
                <h2>Missing Information & Questions</h2>
                <small className="ws-muted">Identified gaps or open questions for team follow-up</small>
              </div>
            </div>
            <button
              type="button"
              className={`ws-onboarding-ack-btn ${reviewedSections.includes('missing_info') ? 'checked' : ''}`}
              onClick={() => handleAcknowledge('missing_info')}
            >
              {reviewedSections.includes('missing_info') ? '✓ Reviewed' : 'Mark as Reviewed'}
            </button>
          </div>
          {cp.missingInformation?.length > 0 ? (
            <div className="ws-card-list">
              {cp.missingInformation.map((m, idx) => (
                <div key={idx} className="ws-card-subitem">
                  <strong>{m.topic}</strong>
                  <p>{m.explanation}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="ws-panel-empty">No critical knowledge gaps reported.</p>
          )}
        </div>

        {/* Section 10: Assigned Documents */}
        <div className={`ws-onboarding-section ${reviewedSections.includes('documents') ? 'is-reviewed' : ''}`}>
          <div className="ws-onboarding-section-header">
            <div className="ws-onboarding-section-title">
              <span className="ws-onboarding-section-num">10</span>
              <div>
                <h2>Assigned Project Documents ({documents.length})</h2>
                <small className="ws-muted">Files specifically selected by your administrator</small>
              </div>
            </div>
            <button
              type="button"
              className={`ws-onboarding-ack-btn ${reviewedSections.includes('documents') ? 'checked' : ''}`}
              onClick={() => handleAcknowledge('documents')}
            >
              {reviewedSections.includes('documents') ? '✓ Reviewed' : 'Mark as Reviewed'}
            </button>
          </div>

          {documents.length > 0 ? (
            <table className="ws-doc-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Type</th>
                  <th>Size</th>
                  <th>Uploaded</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => (
                  <tr key={doc.id}>
                    <td>
                      <strong>{doc.title}</strong>
                      {doc.filename && doc.filename !== doc.title && (
                        <small className="ws-muted" style={{ display: 'block' }}>{doc.filename}</small>
                      )}
                    </td>
                    <td>{doc.mimeType?.split('/')[1] || 'doc'}</td>
                    <td>{formatBytes(doc.size)}</td>
                    <td>{formatDate(doc.createdAt)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          type="button"
                          className="ws-text-button"
                          onClick={() => handlePreview(doc.id)}
                          disabled={previewLoading}
                        >
                          Preview
                        </button>
                        <button
                          type="button"
                          className="ws-text-button"
                          onClick={() => handleDownload(doc.id, doc.filename)}
                        >
                          Download
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="ws-panel-empty">No specific documents assigned to your onboarding.</p>
          )}
        </div>
      </div>

      {/* Completion Action Bar */}
      <div className="ws-onboarding-complete-bar">
        <div>
          <strong style={{ fontSize: 15, display: 'block' }}>
            {isCompleted ? 'Onboarding Finished' : 'Ready to finish your onboarding?'}
          </strong>
          <span className="ws-muted" style={{ fontSize: 13 }}>
            {isCompleted
              ? 'You have marked your onboarding as complete.'
              : `${reviewedSections.length} of ${SECTIONS.length} sections acknowledged.`}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <Link to={`/projects/${projectId}`} className="ws-button">
            Go to Project
          </Link>
          {!isCompleted && (
            <button
              type="button"
              className="ws-button ws-button-primary"
              onClick={handleComplete}
              disabled={busy}
            >
              {busy ? 'Completing…' : 'Mark Onboarding Complete ✓'}
            </button>
          )}
        </div>
      </div>

      {/* Document Preview Drawer/Modal */}
      {previewDoc && (
        <dialog
          className="ws-modal"
          open
          onClick={(e) => { if (e.target === e.currentTarget) setPreviewDoc(null); }}
        >
          <button className="ws-modal-close" onClick={() => setPreviewDoc(null)}>×</button>
          <span className="ws-eyebrow">DOCUMENT PREVIEW</span>
          <h2>{previewDoc.title}</h2>
          <small className="ws-muted">{previewDoc.filename} · {previewDoc.characterCount?.toLocaleString()} characters</small>

          <div className="ws-context-preview-box" style={{ marginTop: 14 }}>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13 }}>
              {previewDoc.text || 'No extractable text.'}
            </pre>
          </div>

          <div className="ws-modal-actions" style={{ marginTop: 20 }}>
            <button type="button" className="ws-button" onClick={() => setPreviewDoc(null)}>
              Close Preview
            </button>
          </div>
        </dialog>
      )}
    </div>
  );
}
