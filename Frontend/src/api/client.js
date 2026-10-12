import { readSession } from '../auth/session'
const base = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
export async function request(path, { method = 'GET', body, signal, token = readSession()?.token } = {}) {
  let response
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: signal || AbortSignal.timeout(15000),
    })
  } catch (error) {
    if (error.name === 'AbortError') throw error
    throw new Error('Couldn’t connect to your workspace. Check your connection and try again.', { cause: error })
  }
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('relay:session-expired'))
    let message = data?.message || 'Something went wrong. Please try again.'
    if (data?.error === 'validation_error') {
      try { message = JSON.parse(message).map(issue => issue.message).join('. ') } catch { /* Plain-text validation messages are already readable. */ }
    }
    const error = new Error(message)
    error.status = response.status
    error.data = data
    throw error
  }
  if (!data) throw new Error('The server returned an unexpected response.')
  return data
}
export async function loadWorkspace(signal) {
  const { projects } = await request('/projects', { signal })
  const results = await Promise.allSettled(projects.map(async project => {
    const [context, handoffData] = await Promise.all([
      request(`/projects/${project.id}/context`, { signal }),
      request(`/projects/${project.id}/handoffs`, { signal }),
    ])
    return { ...project, context, tasks: context.tasks.map(task => ({ ...task, projectId: project.id })), handoffs: handoffData.handoffs }
  }))
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  return {
    projects: projects.map((project, index) => results[index].status === 'fulfilled' ? results[index].value : { ...project, loadError: results[index].reason.message, tasks: [], handoffs: [] }),
  }
}
