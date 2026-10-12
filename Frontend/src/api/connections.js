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
