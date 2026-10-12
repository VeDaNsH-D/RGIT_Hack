import { request } from './client'

export const listProjectConflicts = (projectId, { status, signal } = {}) => {
  const query = status ? `?status=${encodeURIComponent(status)}` : ''
  return request(`/projects/${encodeURIComponent(projectId)}/conflicts${query}`, { signal })
}

export const detectProjectConflicts = (projectId, signal) =>
  request(`/projects/${encodeURIComponent(projectId)}/conflicts/detect`, { method: 'POST', signal })

export const createProjectConflict = (projectId, data) =>
  request(`/projects/${encodeURIComponent(projectId)}/conflicts`, { method: 'POST', body: data })

export const reviewConflict = conflictId =>
  request(`/conflicts/${encodeURIComponent(conflictId)}/review`, { method: 'POST' })

export const resolveConflict = (conflictId, { outcome, note }) =>
  request(`/conflicts/${encodeURIComponent(conflictId)}/resolve`, { method: 'POST', body: { outcome, note } })
