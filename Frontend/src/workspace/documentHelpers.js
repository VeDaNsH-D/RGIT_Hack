export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
const EXTENSIONS = ['pdf', 'docx', 'txt']

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Client-side pre-check so obvious mistakes fail instantly; the server remains the authority. */
export function validateDocumentFile(file, maxBytes = MAX_UPLOAD_BYTES) {
  if (!file) return 'Choose a file to upload.'
  const extension = String(file.name || '').split('.').pop().toLowerCase()
  if (!EXTENSIONS.includes(extension)) return 'Unsupported format. Upload a PDF, DOCX or TXT file.'
  if (!file.size) return 'This file is empty.'
  if (file.size > maxBytes) return `This file is larger than ${formatBytes(maxBytes)}.`
  return ''
}

export const formatLabel = document => (document.filename?.split('.').pop() || document.mimeType || '').toUpperCase()

export const STATUS_LABELS = { uploaded: 'Needs indexing', processing: 'Processing…', indexed: 'Indexed', failed: 'Failed' }
export const STATUS_BADGES = { indexed: 'ws-badge-completed', processing: 'ws-badge-pending', uploaded: 'ws-badge-pending', failed: 'ws-badge-critical' }

// Citation kinds shown in the handoff preview, so GitHub, repository, document and Relay sources are distinguishable.
export const SOURCE_TYPE_LABELS = {
  repository_file: 'Repository file', repository: 'Repository', issue: 'GitHub issue', pull_request: 'Pull request', commit: 'Commit',
  document: 'Uploaded document', jira_issue: 'Jira issue', slack_message: 'Slack message', notion_page: 'Notion page', notion_database: 'Notion database', note: 'Relay note', handoff: 'Previous handoff', task: 'Relay task',
}
