import AppIcon from './AppIcon'
import './Integrations.css'

const leftColumns = [
  [null, 'slack', 'evernote', 'basecamp', 'drive', null],
  [null, 'loom', 'meta', 'clickup', null, null],
  [null, null, 'asana', 'mailchimp', null, null],
]

const rightColumns = [
  [null, null, 'monday', 'zendesk', null, null],
  [null, 'zendesk-gray', 'airtable', 'notion', null, null],
  [null, 'todoist', 'trello', 'zendesk', 'drive', null],
]

function AppWall({ side, columns }) {
  return (
    <div className={`connect-app-wall connect-app-wall-${side}`} aria-hidden="true">
      {columns.map((apps, column) => (
        <div className="connect-app-column" key={column}>
          {apps.map((name, row) => (
            <div className={`connect-app-tile ${name ? `connect-icon-${name}` : 'connect-app-placeholder'}`} key={row}>
              {name ? <AppIcon name={name} /> : <span />}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

export default function Integrations() {
  return (
    <section className="connect-section" aria-labelledby="connect-title">
      <AppWall side="left" columns={leftColumns} />
      <div className="connect-copy">
        <h2 id="connect-title">Connect everything,<br />achieve more</h2>
        <p>Integrate your favorite apps and tools to simplify workflows, reduce<br className="connect-desktop-break" /> manual work, and keep your team in sync.</p>
      </div>
      <AppWall side="right" columns={rightColumns} />
    </section>
  )
}
