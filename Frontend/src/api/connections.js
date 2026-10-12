import { request } from './client'

export const getGitHubStatus = signal => request('/connections/github', { signal })
export const startGitHubInstall = () => request('/connections/github/install', { method: 'POST' })
