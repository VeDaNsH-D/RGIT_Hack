import { readSession } from '../auth/session'
import { request } from './client'

export const getGitHubStatus = signal => request('/connections/github', { signal })
export const startGitHubInstall = () => request('/connections/github/install', { method: 'POST' })
export const getWhatsAppStatus = signal => request('/connections/whatsapp', { signal })
export const connectWhatsApp = phone => request('/connections/whatsapp', { method: 'POST', body: { phone } })
export const disconnectWhatsApp = () => request('/connections/whatsapp', { method: 'DELETE' })

export const getJiraStatus = signal => request('/connections/jira', { signal })
export const connectJira = data => request('/connections/jira', { method: 'POST', body: data })
export const disconnectJira = () => request('/connections/jira', { method: 'DELETE' })
export const syncJira = () => request('/connections/jira/sync', { method: 'POST' })

export const getSlackStatus = signal => request('/connections/slack', { signal })
export const connectSlack = data => request('/connections/slack', { method: 'POST', body: data })
export const disconnectSlack = () => request('/connections/slack', { method: 'DELETE' })
export const syncSlack = () => request('/connections/slack/sync', { method: 'POST' })

export const getNotionStatus = signal => request('/connections/notion', { signal })
export const connectNotion = data => request('/connections/notion', { method: 'POST', body: data })
export const disconnectNotion = () => request('/connections/notion', { method: 'DELETE' })
export const syncNotion = () => request('/connections/notion/sync', { method: 'POST' })

export const listGitHubRepositories = ({ q = '', page = 1, signal } = {}) =>
  request(`/connections/github/repositories?${new URLSearchParams({ q, page: String(page) })}`, { signal })
export const linkGitHubRepository = (projectId, repositoryId) =>
  request(`/projects/${encodeURIComponent(projectId)}/integrations/github`, { method: 'POST', body: { repositoryId } })
export const listProjectRepositories = (projectId, signal) => request(`/projects/${encodeURIComponent(projectId)}/integrations`, { signal })
export const unlinkGitHubRepository = (projectId, connectionId) =>
  request(`/projects/${encodeURIComponent(projectId)}/integrations/github/${encodeURIComponent(connectionId)}`, { method: 'DELETE' })
export const syncGitHubRepository = (projectId, connectionId) =>
  request(`/projects/${encodeURIComponent(projectId)}/integrations/github/${encodeURIComponent(connectionId)}/sync`, { method: 'POST', signal: AbortSignal.timeout(120000) })
export const listGitHubActivity = (projectId, { kind, state, page, signal }) =>
  request(`/projects/${encodeURIComponent(projectId)}/github/activity?${new URLSearchParams({ kind, state, page: String(page) })}`, { signal })
export const draftHandoffWithAi = handoffId => request(`/handoffs/${encodeURIComponent(handoffId)}/ai-draft`, { method: 'POST', signal: AbortSignal.timeout(120000) })
export const listRepositoryKnowledge = (projectId, signal) => request(`/projects/${encodeURIComponent(projectId)}/repository-knowledge`, { signal })
export const analyzeRepository = (projectId, connectionId, force = false) =>
  request(`/projects/${encodeURIComponent(projectId)}/integrations/github/${encodeURIComponent(connectionId)}/analyze`, { method: 'POST', body: { force }, signal: AbortSignal.timeout(180000) })
export const generateHandoffReport = projectId => request(`/projects/${encodeURIComponent(projectId)}/handoff-reports`, { method: 'POST', signal: AbortSignal.timeout(180000) })
export const listHandoffReports = (projectId, signal) => request(`/projects/${encodeURIComponent(projectId)}/handoff-reports`, { signal })
export const getHandoffReport = (projectId, reportId, signal) => request(`/projects/${encodeURIComponent(projectId)}/handoff-reports/${encodeURIComponent(reportId)}`, { signal })

/** Downloads the PDF with the session token (a plain link could not send the Authorization header). */
export async function downloadHandoffPdf(projectId, reportId) {
  const base = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
  const response = await fetch(`${base}/projects/${encodeURIComponent(projectId)}/handoff-reports/${encodeURIComponent(reportId)}/pdf`, { headers: { Authorization: `Bearer ${readSession()?.token}` }, signal: AbortSignal.timeout(60000) })
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw Object.assign(new Error(data?.message || 'The PDF could not be downloaded.'), { status: response.status, data })
  }
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') || '')?.[1] || 'developer-handoff.pdf'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
