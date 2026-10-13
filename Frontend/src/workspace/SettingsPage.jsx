import { useAuth } from '../auth/AuthContext'
import { PageHeading } from './ui'

export default function SettingsPage() {
  const { session } = useAuth()
  const { name, email } = session.user
  return <>
    <PageHeading eyebrow="ACCOUNT" title="Settings" description="Your account details." />
    <section className="ws-panel ws-settings">
      <div className="ws-settings-row"><span>Name</span><strong>{name || '—'}</strong></div>
      <div className="ws-settings-row"><span>Email</span><strong>{email || '—'}</strong></div>
    </section>
  </>
}
