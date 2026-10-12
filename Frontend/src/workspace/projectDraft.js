// Keeps the Create Project text across the GitHub authorization round trip. Only the
// name and description are stored (never credentials), for this tab and 30 minutes at most.
const key = 'over2u-project-draft'
const maxAge = 30 * 60 * 1000

export function saveProjectDraft({ name, description }) {
  try { sessionStorage.setItem(key, JSON.stringify({ name, description, savedAt: Date.now() })) } catch { /* Draft is a convenience only. */ }
}
export function loadProjectDraft() {
  try {
    const draft = JSON.parse(sessionStorage.getItem(key))
    if (draft && Date.now() - draft.savedAt < maxAge) return { name: String(draft.name || ''), description: String(draft.description || '') }
  } catch { /* Ignore unreadable drafts. */ }
  return null
}
export function clearProjectDraft() {
  try { sessionStorage.removeItem(key) } catch { /* Nothing to clear. */ }
}
