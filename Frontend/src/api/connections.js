import { request } from './client'

export const getGitHubStatus = signal => request('/connections/github', { signal })
export const startGitHubInstall = () => request('/connections/github/install', { method: 'POST' })

export const getWhatsAppStatus = signal => request('/connections/whatsapp', { signal })
export const connectWhatsApp = phone => request('/connections/whatsapp', { method: 'POST', body: { phone } })
export const disconnectWhatsApp = () => request('/connections/whatsapp', { method: 'DELETE' })
