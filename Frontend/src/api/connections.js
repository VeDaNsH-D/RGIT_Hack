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
