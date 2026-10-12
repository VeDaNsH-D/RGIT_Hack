import './Features.css'
import AppIcon from './AppIcon'

function Portrait({ person }) {
  return <span className={`feature-portrait portrait-${person}`}>
    <span className="portrait-shirt" /><span className="portrait-hair" />
    <span className="portrait-face"><i /><i /><span /></span>
  </span>
}

function CollaborationIllustration() {
  return (
    <div className="collaboration-illustration" aria-hidden="true">
      <div className="collaboration-people">
        {['smith', 'alisa', 'sam', 'alex'].map(person => (
          <div className="collaboration-person" key={person}>
            <Portrait person={person} />
            <div className="collaboration-lines"><span /><span /></div>
          </div>
        ))}
      </div>
      <span className="collaboration-cursor cursor-smith"><i /><span>Smith W.</span></span>
      <span className="collaboration-cursor cursor-alisa"><i /><span>Alisa M.</span></span>
      <span className="collaboration-cursor cursor-alex"><i /><span>Alex D.</span></span>
    </div>
  )
}

const communicationApps = ['slack', 'notion', 'monday', 'evernote', 'loom', 'trello', 'todoist', 'asana']

function CommunicationIllustration() {
  return (
    <div className="communication-illustration" aria-hidden="true">
      <div className="integration-halo"><span /><span /></div>
      {communicationApps.map(name => <div key={name} className={`app-tile integration-${name}`}><AppIcon name={name}/></div>)}
      <span className="hub-icon"><i /><i /><i /><span /></span>
    </div>
  )
}

function TaskRow({ title, mobile = false }) {
  return (
    <div className={`management-task ${mobile ? 'management-task-secondary' : ''}`}>
      <div className="management-task-top">
        <span className="management-task-name"><span className={mobile ? 'device-icon' : 'browser-icon'} />{title}</span>
        <div className={`management-progress ${mobile ? 'progress-empty' : ''}`}><span /></div>
        {!mobile && <span className="progress-value">45%</span>}
      </div>
      <div className="management-task-bottom">
        <span className="task-label"><span className="priority-flag"/>Urgent</span>
        <span className="task-label"><span className={`hourglass ${mobile ? 'hourglass-orange' : ''}`}>⌛</span>{mobile ? 'To Do' : 'In Progress'}</span>
        <div className="task-assignees">
          {['smith', 'sam', 'alex'].map(person => mobile ? <span className="empty-assignee" key={person}/> : <Portrait person={person} key={person}/>)}
          {!mobile && <span className="assignee-count">+3</span>}
        </div>
      </div>
    </div>
  )
}

function TaskIllustration() {
  return <div className="management-illustration" aria-hidden="true"><TaskRow title="Website design"/><TaskRow title="App design" mobile/></div>
}

function CloudIllustration() {
  return (
    <div className="cloud-illustration" aria-hidden="true">
      <svg className="cloud-shield" viewBox="0 0 360 290" fill="none">
        {[0, 1, 2, 3].map(i => <path key={i} d="M180 12 322 56v84c0 75-54 118-142 151C92 258 38 215 38 140V56Z" stroke="#f3ae4590" strokeWidth="1.2" transform={`translate(${i * 18} ${i * 17}) scale(${1 - i * .1})`}/>)}
      </svg>
      <span className="cloud-symbol"><svg viewBox="0 0 90 76"><path d="M26 64C5 64 3 40 18 33 22 4 60 0 71 28 93 32 94 64 73 64Z" fill="#ff9b16"/><path d="M30 51c-11 0-12-13-3-16 2-15 22-17 28-2 13 0 17 18 4 18Z" fill="#fffaf0"/><path d="m33 25 10 7-9 8" stroke="#ff9b16" strokeWidth="7" fill="none"/></svg></span>
      {['mailchimp', 'drive', 'zendesk', 'aws', 'airtable', 'zapier'].map(name => <div className={`app-tile cloud-${name}`} key={name}><AppIcon name={name}/></div>)}
    </div>
  )
}

const features = [
  {
    id: 'collaboration',
    title: 'Real-Time Collaboration',
    description: 'Collaborate on projects instantly, share ideas, and edit documents together in real-time — keeping everyone aligned and productive.',
    Illustration: CollaborationIllustration,
  },
  {
    id: 'communication',
    title: 'Unified Communication Hub',
    description: 'Send messages, share files, and host video calls — all in a single workspace to reduce confusion and improve collaboration.',
    Illustration: CommunicationIllustration,
  },
  {
    id: 'management',
    title: 'Smart Task Management',
    description: 'Visual boards, automated reminders, and progress tracking help your team stay organized, hit deadlines, and achieve goals efficiently.',
    Illustration: TaskIllustration,
  },
  {
    id: 'cloud',
    title: 'Secure Cloud Workspace',
    description: 'Your files, chats, and data are protected with strong encryption and reliable cloud backups, ensuring peace of mind for your team.',
    Illustration: CloudIllustration,
  },
]

export default function Features() {
  return (
    <section className="features-section" aria-labelledby="features-title" id="features">
      <div className="features-inner">
        <header className="features-heading">
          <h2 id="features-title">Empower your<br/>team, achieve more</h2>
          <p>Discover powerful tools that collaboration, boost productivity, and<br className="features-desktop-break"/> keep your team connected all in one platform.</p>
        </header>
        <div className="features-grid">
          {features.map(({ id, title, description, Illustration }) => (
            <article className={`feature-card feature-card-${id}`} key={id} aria-labelledby={`feature-${id}`}>
              <div className="feature-visual"><Illustration/></div>
              <div className="feature-copy">
                <h3 id={`feature-${id}`}>{title}</h3>
                <p>{description}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}
