import { request } from '../api/client'

let returned = null
const returnKey = 'over2u-oauth-return'
export function safeDestination(value) {
  return /^\/(?:dashboard|projects|tasks|handoffs)(?:\/|\?|$)/.test(value || '') ? value : '/dashboard'
}
export function beginGoogleSignIn(destination) {
  try { sessionStorage.setItem(returnKey, safeDestination(destination)) } catch { /* Dashboard is the fallback. */ }
  const base = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
  window.location.assign(`${base}/auth/oauth/google`)
}
export function captureOAuthReturn() {
  const url = new URL(window.location.href)
  if (!['/', '/auth/callback'].includes(url.pathname)) return
  const fragment = new URLSearchParams(url.hash.slice(1))
  const token = fragment.get('token') || url.searchParams.get('token')
  const error = url.searchParams.get('error')
  if (!token && url.pathname !== '/auth/callback') return
  returned = { token, error }
  // Remove the credential before the router renders or other requests run.
  window.history.replaceState(null, '', '/auth/callback')
}
export function getOAuthReturn() { return returned }
export function clearOAuthReturn() { returned = null }
export function takeOAuthDestination() {
  try {
    const value = sessionStorage.getItem(returnKey)
    sessionStorage.removeItem(returnKey)
    return safeDestination(value)
  } catch { return '/dashboard' }
}
export async function verifyOAuthReturn(token, signal) {
  if (!token) throw new Error('No sign-in session was returned. Please try again.')
  const { user } = await request('/auth/me', { token, signal })
  if (!user?.id) throw new Error('Couldn’t verify your account. Please try again.')
  return { token, user }
}
