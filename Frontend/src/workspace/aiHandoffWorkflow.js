// Pure helpers behind "Generate AI Handoff" so the workflow can be unit-tested without a browser.

/** Creates the handoff only when none exists, then asks the existing endpoint for a draft. */
export async function generateAiHandoff({ existing, recipientId, createHandoff, draft, onHandoff }) {
  let handoffId = existing?.id
  if (!handoffId) {
    const { handoff } = await createHandoff(recipientId)
    handoffId = handoff.id
    onHandoff?.(handoffId) // remembered so a retry after an AI failure never creates a second handoff
  }
  const result = await draft(handoffId)
  return { handoffId, handoff: result.handoff }
}

/** Maps backend errors onto the states the UI distinguishes. */
export function describeDraftError(error) {
  const code = error?.data?.error
  if (code === 'insufficient_context') return { kind: 'no_data', message: 'There isn’t enough project context to draft from yet. Connect a repository, add tasks, or add notes, then try again.' }
  if (code === 'not_synced') return { kind: 'unsynced', message: 'Your repository hasn’t been synchronized yet. Use “Sync now” on the repository card, then try again.' }
  const detail = String(error?.message || '')
  if (/Malformed model output|unreadable|malformed/i.test(detail)) return { kind: 'failed', message: 'The AI returned an unreadable draft. Nothing was lost; please try again.' }
  if (/413|too large|tokens per minute|token limit/i.test(detail)) return { kind: 'too_large', message: 'The AI provider’s token limit was exceeded. Wait a minute and retry, lower AI_HANDOFF_CONTEXT_CHARS, or use a model with a higher limit.' }
  if (/GROQ_API_KEY/.test(detail)) return { kind: 'unavailable', message: 'The AI service has no API key configured. Add GROQ_API_KEY to aiml/.env and restart it.' }
  if (['AI_SERVICE_CONNECTION_ERROR', 'AI_SERVICE_TIMEOUT'].includes(code) || [502, 503, 504].includes(error?.status)) return { kind: 'unavailable', message: 'The AI service is unavailable right now. Your handoff was kept, so you can retry without losing anything.' }
  if (code === 'conflict') return { kind: 'conflict', message: 'A handoff is already open for this project.' }
  return { kind: 'failed', message: error?.message || 'Something went wrong while drafting. Your handoff was kept; please try again.' }
}

const latest = values => values.filter(Boolean).sort().at(-1) || null

/** Honest summary of the connected repositories; counts are null unless every repository has real data. */
export function summarizeContext(connections) {
  const list = connections || []
  if (!list.length) return { repositories: 0, sync: 'No repository connected', openIssues: null, openPullRequests: null, lastActivity: null }
  const statuses = list.map(connection => connection.sync?.status || 'pending')
  const sync = statuses.includes('syncing') ? 'Syncing…'
    : statuses.includes('failed') ? `${statuses.filter(status => status === 'failed').length} of ${list.length} failed`
    : statuses.includes('partial') ? 'Partially synced'
    : statuses.includes('pending') ? 'Not synced yet'
    : 'Up to date'
  const hasCounts = list.every(connection => ['ready', 'stale'].includes(connection.stats?.state))
  return {
    repositories: list.length,
    sync,
    openIssues: hasCounts ? list.reduce((sum, connection) => sum + connection.stats.openIssues, 0) : null,
    openPullRequests: hasCounts ? list.reduce((sum, connection) => sum + connection.stats.openPullRequests, 0) : null,
    lastActivity: latest(list.flatMap(connection => [connection.sync?.lastSuccessAt, connection.stats?.latestCommitAt])),
  }
}
