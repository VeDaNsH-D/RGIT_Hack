import { readSession } from '../auth/session'
import { request } from './client'

const base = () => (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
const root = projectId => `/projects/${encodeURIComponent(projectId)}/documents`

export const DOCUMENT_ACCEPT = '.pdf,.docx,.txt'
export const DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'txt']

export const listProjectDocuments = (projectId, signal) => request(`${root(projectId)}?limit=100`, { signal })
export const getDocumentPreview = (projectId, documentId, signal) => request(`${root(projectId)}/${encodeURIComponent(documentId)}/preview`, { signal })
export const deleteProjectDocument = (projectId, documentId) => request(`${root(projectId)}/${encodeURIComponent(documentId)}`, { method: 'DELETE' })
export const retryDocument = (projectId, documentId) => request(`${root(projectId)}/${encodeURIComponent(documentId)}/reindex`, { method: 'POST', body: {}, signal: AbortSignal.timeout(120000) })

/** Multipart upload; `request()` is JSON-only, so the form body goes through fetch directly. */
async function sendFile(path, method, file) {
  const form = new FormData()
  form.append('file', file)
  let response
  try {
    response = await fetch(`${base()}${path}`, { method, headers: { Authorization: `Bearer ${readSession()?.token}` }, body: form, signal: AbortSignal.timeout(120000) })
  } catch {
    throw new Error('Couldn’t connect to your workspace. Check your connection and try again.')
  }
  const data = await response.json().catch(() => null)
  if (response.status === 401) window.dispatchEvent(new Event('relay:session-expired'))
  if (!response.ok) throw Object.assign(new Error(data?.message || 'The document could not be uploaded.'), { status: response.status, data })
  return data
}
export const uploadProjectDocument = (projectId, file) => sendFile(root(projectId), 'POST', file)
export const replaceProjectDocument = (projectId, documentId, file) => sendFile(`${root(projectId)}/${encodeURIComponent(documentId)}/file`, 'PUT', file)

/** Fetches the original with the session token (a plain link cannot send Authorization) and saves it. */
export async function downloadProjectDocument(projectId, documentId, fallbackName = 'document') {
  const response = await fetch(`${base()}${root(projectId)}/${encodeURIComponent(documentId)}/file`, { headers: { Authorization: `Bearer ${readSession()?.token}` }, signal: AbortSignal.timeout(60000) })
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw Object.assign(new Error(response.status === 404 ? 'This document is no longer available.' : data?.message || 'The document could not be downloaded.'), { status: response.status })
  }
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') || '')?.[1] || fallbackName
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
