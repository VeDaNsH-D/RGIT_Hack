const key = 'over2u-session'
let memorySession = null
export function readSession() {
  try {
    const value = JSON.parse(sessionStorage.getItem(key))
    return value?.token && value?.user?.id ? value : memorySession
  } catch { return memorySession }
}
export function storeSession(session) {
  memorySession = session
  try {
    if (session) sessionStorage.setItem(key, JSON.stringify(session))
    else sessionStorage.removeItem(key)
  } catch { /* The in-memory session still works when storage is unavailable. */ }
}
