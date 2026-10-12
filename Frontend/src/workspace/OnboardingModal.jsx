import { useEffect, useRef, useState } from 'react';
import { listProjectDocuments } from '../api/documents';
import { createOnboarding } from '../api/onboarding';
import { useWorkspace } from './WorkspaceContext';
import { formatDate } from './utils';
import { formatBytes } from './documentHelpers';
import { Icon } from './ui';
import './onboarding.css';

export default function OnboardingModal({ projectId, projectName, onClose, onCreated }) {
  const dialog = useRef(null);
  const { projects } = useWorkspace();
  const currentProject = projects.find((p) => p.id === projectId);
  const existingMembers = (currentProject?.context?.members || []).filter((m) => m.email);

  const [step, setStep] = useState(1);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');

  // Step 2: Document selection
  const [documents, setDocuments] = useState([]);
  const [selectedDocIds, setSelectedDocIds] = useState([]);
  const [docSearch, setDocSearch] = useState('');
  const [docsLoading, setDocsLoading] = useState(true);

  // Status & submission
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setDocsLoading(true);
    listProjectDocuments(projectId, controller.signal)
      .then((data) => {
        const docs = data?.items || [];
        setDocuments(docs);
        // By default, select all indexed documents
        setSelectedDocIds(docs.map((d) => d.id));
        setDocsLoading(false);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          setError('Could not load project documents.');
          setDocsLoading(false);
        }
      });
    return () => controller.abort();
  }, [projectId]);

  const filteredDocs = documents.filter((d) =>
    `${d.title} ${d.filename}`.toLowerCase().includes(docSearch.toLowerCase())
  );

  function toggleDoc(id) {
    setSelectedDocIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  }

  function selectAllDocs() {
    setSelectedDocIds(filteredDocs.map((d) => d.id));
  }

  function deselectAllDocs() {
    setSelectedDocIds([]);
  }

  async function handleConfirm(e) {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');

    try {
      const res = await createOnboarding(projectId, {
        email: email.trim(),
        role,
        selectedDocumentIds: selectedDocIds,
        generateAiContext: true,
        sendInvitation: true,
      });

      setSuccess('Onboarding assignment created successfully.');
      if (onCreated) {
        await onCreated(res.assignment);
      }
      setTimeout(() => {
        onClose();
      }, 1200);
    } catch (err) {
      setError(err.message || 'Failed to create onboarding assignment.');
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="ws-modal"
      onCancel={(e) => { if (busy) e.preventDefault(); else onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <button className="ws-modal-close" aria-label="Close dialog" onClick={onClose} disabled={busy}>×</button>
      <span className="ws-eyebrow">PROJECT ONBOARDING & CONTINUITY</span>
      <h2>Onboard a Teammate</h2>
      <p className="ws-muted">
        Assign project context, choose relevant reference documents, and generate a structured briefing for your new member.
      </p>

      {error && <p className="ws-error" role="alert">{error}</p>}
      {success && <p className="ws-notice" role="status">{success}</p>}

      {step === 1 && (
        <form onSubmit={(e) => { e.preventDefault(); if (email) setStep(2); }}>
          <label>
            Teammate email
            <input
              type="email"
              required
              placeholder="colleague@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              list="existing-teammates-datalist"
              autoFocus
            />
          </label>
          {existingMembers.length > 0 && (
            <datalist id="existing-teammates-datalist">
              {existingMembers.map((m) => (
                <option key={m.userId || m.email} value={m.email}>
                  {m.name ? `${m.name} (${m.role})` : m.email}
                </option>
              ))}
            </datalist>
          )}
          <label>
            Assigned project role
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="member">Member — contribute to tasks and update context</option>
              <option value="viewer">Viewer — read-only access to project briefing</option>
            </select>
          </label>
          <div className="ws-modal-actions" style={{ marginTop: 24 }}>
            <button type="button" className="ws-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="ws-button ws-button-primary" disabled={!email.trim()}>
              Next: Select Documents →
            </button>
          </div>
        </form>
      )}

      {step === 2 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <label style={{ margin: 0, fontWeight: 600 }}>
              Select Documents for {email} ({selectedDocIds.length} of {documents.length} selected)
            </label>
          </div>
          <p className="ws-muted" style={{ fontSize: 12, margin: '0 0 10px' }}>
            Only selected documents will be shared with this member during onboarding.
          </p>

          <input
            type="search"
            placeholder="Search documents…"
            value={docSearch}
            onChange={(e) => setDocSearch(e.target.value)}
            style={{ width: '100%', marginBottom: 8 }}
          />

          <div className="ws-doc-select-actions">
            <span>{filteredDocs.length} document(s) matching</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="ws-text-button" onClick={selectAllDocs}>Select all</button>
              <button type="button" className="ws-text-button" onClick={deselectAllDocs}>Deselect all</button>
            </div>
          </div>

          <div className="ws-doc-select-list">
            {docsLoading ? (
              <p className="ws-panel-empty">Loading documents…</p>
            ) : filteredDocs.length === 0 ? (
              <p className="ws-panel-empty">No documents found.</p>
            ) : (
              filteredDocs.map((doc) => {
                const isSelected = selectedDocIds.includes(doc.id);
                return (
                  <div
                    key={doc.id}
                    className={`ws-doc-select-row ${isSelected ? 'selected' : ''}`}
                    onClick={() => toggleDoc(doc.id)}
                  >
                    <div className="ws-doc-select-row-left">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {}}
                        aria-label={`Select ${doc.title}`}
                      />
                      <div>
                        <strong style={{ fontSize: 13, display: 'block' }}>{doc.title}</strong>
                        <small className="ws-muted">{[doc.filename, formatBytes(doc.size), formatDate(doc.createdAt)].filter(Boolean).join(' · ')}</small>
                      </div>
                    </div>
                    <span className="ws-badge">{doc.mimeType?.split('/')[1] || 'doc'}</span>
                  </div>
                );
              })
            )}
          </div>

          <div className="ws-modal-actions" style={{ marginTop: 24 }}>
            <button type="button" className="ws-button" onClick={() => setStep(1)} disabled={busy}>← Back</button>
            <button type="button" className="ws-button ws-button-primary" onClick={() => setStep(3)} disabled={busy}>
              Next: Review & Generate Draft →
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div>
          <div className="ws-ai-draft-badge">
            <Icon name="sparkles" size={13} />
            <span>AI Context Intelligence Preview</span>
          </div>
          <p className="ws-muted" style={{ fontSize: 13 }}>
            Relay will synthesize a 10-section onboarding briefing for <strong>{email}</strong> covering project overview, status, decisions, troubleshooting history, pending tasks, and the <strong>{selectedDocIds.length}</strong> selected documents.
          </p>

          <div className="ws-context-preview-box">
            <h4 style={{ margin: '0 0 6px 0', fontSize: 13 }}>Included Onboarding Modules:</h4>
            <ul style={{ margin: 0, paddingLeft: 18, color: '#475569', fontSize: 12.5, lineHeight: 1.6 }}>
              <li><strong>Project Overview & Tech Stack:</strong> Core objectives and technology ecosystem</li>
              <li><strong>Current Status:</strong> Active milestones and sprint focus</li>
              <li><strong>Completed Work:</strong> Accomplished features and merged deliverables</li>
              <li><strong>Key Decisions & Rationale:</strong> Architectural choices with supporting references</li>
              <li><strong>Previous Troubleshooting:</strong> Actions attempted and outcomes to avoid duplicate pitfalls</li>
              <li><strong>Blockers & Risks:</strong> Unresolved impediments with severity levels</li>
              <li><strong>Pending Tasks & Deadlines:</strong> Prioritized action items ready for handoff</li>
              <li><strong>Recommended Next Steps:</strong> Guided immediate onboarding trajectory</li>
              <li><strong>Assigned Project Documents ({selectedDocIds.length}):</strong> Restricted reference materials</li>
            </ul>
          </div>

          <div className="ws-modal-actions" style={{ marginTop: 24 }}>
            <button type="button" className="ws-button" onClick={() => setStep(2)} disabled={busy}>← Back</button>
            <button
              type="button"
              className="ws-button ws-button-primary"
              onClick={handleConfirm}
              disabled={busy || Boolean(success)}
            >
              {busy ? 'Synthesizing & Assigning…' : 'Confirm & Create Onboarding'}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
