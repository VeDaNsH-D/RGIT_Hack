import { useState } from 'react'
import { Badge } from './ui'
import { formatDate } from './utils'

export default function TroubleshootingHistory({ project }) {
  const [isOpen, setIsOpen] = useState(false)

  const handoffs = project.handoffs || []
  const tasks = project.tasks || []

  // Synthesize historical troubleshooting events from project handoffs and tasks
  const events = []

  for (const h of handoffs) {
    if (h.clarifications?.length) {
      for (const c of h.clarifications) {
        events.push({
          id: `clarification-${c.createdAt || h.id}`,
          date: c.createdAt || h.createdAt,
          title: `Clarification: ${c.type}`,
          description: c.note,
          status: 'warning',
          tag: 'Handoff Q&A',
        })
      }
    }

    if (h.state === 'CLARIFICATION_REQUESTED') {
      events.push({
        id: `handoff-clarify-${h.id}`,
        date: h.updatedAt || h.createdAt,
        title: 'Clarification Requested on Handoff',
        description: 'Teammate requested additional context before accepting ownership.',
        status: 'warning',
        tag: 'Clarification Loop',
      })
    }

    if (h.state === 'ACKNOWLEDGED' || !h.isOpen) {
      events.push({
        id: `handoff-done-${h.id}`,
        date: h.acknowledgedAt || h.updatedAt || h.createdAt,
        title: 'Handoff Successfully Completed',
        description: `Ownership transferred. ${h.items?.length || 0} context items and status verified.`,
        status: 'success',
        tag: 'Resolved',
      })
    }
  }

  for (const t of tasks) {
    if (t.status === 'completed' || t.status === 'done') {
      events.push({
        id: `task-${t.id}`,
        date: t.updatedAt || t.createdAt,
        title: `Task Resolved: ${t.title}`,
        description: t.description || 'Action item resolved and closed.',
        status: 'resolved',
        tag: 'Task Action',
      })
    }
  }

  events.sort((a, b) => new Date(b.date) - new Date(a.date))

  return (
    <section className="ws-panel" aria-labelledby="troubleshoot-heading" style={{ marginTop: '22px' }}>
      <div className="ws-section-heading">
        <div>
          <h2 id="troubleshoot-heading">Troubleshooting & Context History</h2>
          <p>Chronological record of attempts, diagnostic outcomes, clarifications, and past resolutions.</p>
        </div>
        <button
          type="button"
          className="ws-text-button"
          onClick={() => setIsOpen(!isOpen)}
        >
          {isOpen ? 'Collapse history' : `View history (${events.length})`}
        </button>
      </div>

      {isOpen && (
        <div style={{ marginTop: '14px' }}>
          {events.length === 0 ? (
            <p className="ws-panel-empty">No troubleshooting history or past handoff loops recorded yet.</p>
          ) : (
            <div className="ws-troubleshoot-timeline">
              {events.slice(0, 20).map(evt => (
                <div key={evt.id} className={`ws-troubleshoot-node ${evt.status}`}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong style={{ fontSize: '13px', color: 'var(--ws-ink)' }}>{evt.title}</strong>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      <span className="ws-badge">{evt.tag}</span>
                      <small className="ws-muted">{formatDate(evt.date)}</small>
                    </div>
                  </div>
                  <p style={{ margin: 0, fontSize: '12px', color: '#64748b', lineHeight: '1.5' }}>
                    {evt.description}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
