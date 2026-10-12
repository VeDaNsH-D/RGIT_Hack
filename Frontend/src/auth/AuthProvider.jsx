import { useCallback, useEffect, useState } from 'react'
import { AuthContext } from './AuthContext'
import { readSession, storeSession } from './session'
import { request } from '../api/client'
import { getOAuthReturn } from './oauth'

export default function AuthProvider({ children }) {
  const [session, setSession] = useState(readSession)
  const [checking, setChecking] = useState(() => Boolean(readSession()) && !getOAuthReturn()?.token)
  const [error, setError] = useState('')
  const signOut = useCallback(() => {
    storeSession(null)
    setSession(null)
    setError('')
    setChecking(false)
  }, [])
  const acceptSession = useCallback(value => {
    storeSession(value)
    setSession(value)
    setError('')
    setChecking(false)
  }, [])

  useEffect(() => {
    window.addEventListener('relay:session-expired', signOut)
    return () => window.removeEventListener('relay:session-expired', signOut)
  }, [signOut])

  useEffect(() => {
    const stored = readSession()
    if (!stored || getOAuthReturn()?.token) return
    const controller = new AbortController()
    request('/auth/me', { token: stored.token, signal: controller.signal })
      .then(({ user }) => { if (!controller.signal.aborted) acceptSession({ token: stored.token, user }) })
      .catch(err => {
        if (controller.signal.aborted || err.status === 401) return
        setError(err.message)
        setChecking(false)
      })
    return () => controller.abort()
  }, [acceptSession])

  async function retry() {
    setChecking(true)
    try {
      const { user } = await request('/auth/me', { token: session.token })
      acceptSession({ token: session.token, user })
    } catch (err) { setError(err.message); setChecking(false) }
  }
  return <AuthContext.Provider value={{ session, checking, error, retry, acceptSession, signOut }}>{children}</AuthContext.Provider>
}
