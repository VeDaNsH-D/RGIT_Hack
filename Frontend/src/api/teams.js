import { request } from './client'

const base = projectId => `/projects/${encodeURIComponent(projectId)}`

export const listTeams = (projectId, signal) => request(`${base(projectId)}/teams`, { signal })
export const getTeam = (projectId, teamId, signal) => request(`${base(projectId)}/teams/${encodeURIComponent(teamId)}`, { signal })
export const createTeam = (projectId, body) => request(`${base(projectId)}/teams`, { method: 'POST', body })
export const updateTeam = (projectId, teamId, body) => request(`${base(projectId)}/teams/${encodeURIComponent(teamId)}`, { method: 'PATCH', body })
export const addTeamMember = (projectId, teamId, body) => request(`${base(projectId)}/teams/${encodeURIComponent(teamId)}/members`, { method: 'POST', body })
export const setTeamMemberRole = (projectId, teamId, userId, role) => request(`${base(projectId)}/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`, { method: 'PATCH', body: { role } })
export const removeTeamMember = (projectId, teamId, userId) => request(`${base(projectId)}/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' })
export const eligibleRecipients = (projectId, teamId, signal) => request(`${base(projectId)}/teams/${encodeURIComponent(teamId)}/eligible-recipients`, { signal })
export const setOwningTeam = (projectId, teamId) => request(`${base(projectId)}/owning-team`, { method: 'PUT', body: { teamId } })
export const ownershipHistory = (projectId, signal) => request(`${base(projectId)}/ownership-history`, { signal })
export const handoffDetail = (handoffId, signal) => request(`/handoffs/${encodeURIComponent(handoffId)}`, { signal })
export const rejectHandoff = (handoffId, reason) => request(`/handoffs/${encodeURIComponent(handoffId)}/reject`, { method: 'POST', body: { reason } })
export const searchTeams = (search, projectId, signal, directory = 'global') => request(`/teams?${new URLSearchParams({ ...(search ? { search } : {}), ...(projectId ? { projectId } : {}), ...(directory ? { directory } : {}) })}`, { signal })
export const linkTeam = (projectId, teamId) => request(`${base(projectId)}/teams/link`, { method: 'POST', body: { teamId } })
export const unlinkTeam = (projectId, teamId) => request(`${base(projectId)}/teams/${encodeURIComponent(teamId)}/link`, { method: 'DELETE' })
export const formTeamFromMembers = projectId => request(`${base(projectId)}/teams/from-members`, { method: 'POST', body: {} })
export const addTeamMembersToProject = (projectId, teamId) => request(`${base(projectId)}/teams/${encodeURIComponent(teamId)}/add-members`, { method: 'POST', body: {} })

