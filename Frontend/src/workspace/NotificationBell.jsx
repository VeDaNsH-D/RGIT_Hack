import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { request } from '../api/client'
import './notifications.css'
import { notificationDestination } from './notificationLinks'

export default function NotificationBell() {
  const [open, setOpen] = useState(false)
  const [unread, setUnread] = useState(0)
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [more, setMore] = useState(false)
  const root = useRef(null)
  const trigger = useRef(null)
  const navigate = useNavigate()
  const refresh = useCallback(async signal => {
    try {
      const [count, list] = await Promise.all([request('/notifications/unread-count', { signal }), open ? request('/notifications?limit=20', { signal }) : null])
      if (signal?.aborted) return
      setUnread(count.data.unreadCount)
      if (list) { setItems(list.data.items); setMore(list.data.items.length === 20) }
      setError(''); setLoading(false)
    } catch (failure) { if (!signal?.aborted) { setError(failure.message); setLoading(false) } }
  }, [open])
  useEffect(() => {
    const controller = new AbortController()
    let running = false
    async function update() {
      if (running || document.hidden) return
      running = true
      try { await refresh(controller.signal) } finally { running = false }
    }
    update()
    const timer = setInterval(update, 15000)
    window.addEventListener('focus', update)
    document.addEventListener('visibilitychange', update)
    return () => { clearInterval(timer); controller.abort(); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update) }
  }, [refresh])
  useEffect(() => {
    if (!open) return
    function closeOutside(event) { if (!root.current?.contains(event.target)) setOpen(false) }
    function escape(event) { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus() } }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', escape) }
  }, [open])
  async function action(operation) {
    setBusy(true); setError('')
    try { await operation() } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  async function visit(item) {
    if (!item.readAt) await request(`/notifications/${encodeURIComponent(item.id)}/read`, { method: 'PATCH' })
    setItems(previous => previous.map(value => value.id === item.id ? { ...value, readAt: value.readAt || new Date().toISOString() } : value))
    if (!item.readAt) setUnread(previous => Math.max(0, previous - 1))
    setOpen(false); navigate(notificationDestination(item))
  }
  return <div className="ws-notifications" ref={root}>
    <button className="ws-notification-trigger" ref={trigger} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open} aria-controls="workspace-notifications" onClick={() => { setOpen(value => !value); setLoading(true) }}>
      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z"/><path d="M10 21h4"/></svg>
      {unread > 0 && <span className="ws-notification-count" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}{error && !open && <span className="ws-notification-offline" title="Notifications unavailable"/>}
    </button>
    {open && <section id="workspace-notifications" className="ws-notification-dropdown" aria-label="Notifications">
      <div className="ws-notification-heading"><h2>Notifications <span>{unread} unread</span></h2><button className="ws-text-button" disabled={busy || !unread} onClick={() => action(async () => { await request('/notifications/read-all', { method: 'PATCH' }); await refresh() })}>Mark all read</button></div>
      {error && <div className="ws-notification-error" role="alert"><p>{error}</p><button className="ws-text-button" disabled={busy} onClick={() => action(() => refresh())}>Retry</button></div>}
      {loading && !items.length ? <p className="ws-notification-empty" role="status">Loading notifications…</p> : !items.length && !error ? <div className="ws-notification-empty"><strong>You’re all caught up</strong><p>Invitations and updates from your project teammates will appear here.</p></div> : <div className="ws-notification-list">{items.map(item => <button key={item.id} className={`ws-notification-item ${item.readAt ? '' : 'unread'}`} disabled={busy} onClick={() => action(() => visit(item))}><span className="ws-notification-dot"/><span><strong>{item.title}</strong><p>{item.message}</p><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></span></button>)}</div>}
      {more && <button className="ws-notification-more" disabled={busy} onClick={() => action(async () => { const data = await request(`/notifications?limit=20&offset=${items.length}`); setItems(previous => [...new Map([...previous, ...data.data.items].map(item => [item.id, item])).values()]); setMore(data.data.items.length === 20) })}>Load older notifications</button>}
    </section>}
  </div>
}
