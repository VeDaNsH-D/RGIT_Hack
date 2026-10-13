import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import BrandIcon from './BrandIcon'
import './ClosingSection.css'

const contactEmail = 'hello@over2u.app'

const footerColumns = [
  { title: 'Product', links: [
    { label: 'About Us', href: '#hero-title' },
    { label: 'Features', href: '#features' },
    { label: 'Handoffs' },
    { label: 'Reviews', href: '#testimonials-title' },
    { label: 'Pricing' },
  ] },
  { title: 'Company', links: [
    { label: 'Integrations', href: '#connect-title' },
    { label: 'Project Chat' },
    { label: 'Live Calls' },
    { label: 'Contact Us', href: `mailto:${contactEmail}` },
    { label: 'FAQ', href: '#faq' },
  ] },
  { title: 'Resources', links: [
    { label: 'Documentation' },
    { label: 'Sign In', href: '/signin' },
    { label: 'Get Started', href: '/signup' },
    { label: 'Error 404', href: '/404' },
  ] },
  { title: 'Utilities', links: [
    { label: 'Privacy Policy' },
    { label: 'Terms & Conditions' },
    { label: 'Cookies Policy' },
  ] },
]

// A repeatable pixel pattern, generated as individual CSS squares.
const pixels = Array.from({ length: 50 * 34 }, (_, index) => {
  const hash = Math.imul(index + 17, 1597334677) ^ Math.imul(index + 91, 3812015801)
  const value = (hash >>> 0) / 4294967295
  if (value > .43) return null
  return { index, left: `${(index % 50) * 2}%`, top: `${Math.floor(index / 50) * 100 / 34}%`, opacity: .07 + value * .21 }
}).filter(Boolean)

function PixelBackground() {
  return <div className="closing-pixels" aria-hidden="true">
    {pixels.map(({ index, left, top, opacity }) => <span key={index} style={{ left, top, opacity }} />)}
  </div>
}

export default function ClosingSection() {
  const dialog = useRef(null)
  const [panel, setPanel] = useState('')

  function openPanel(title) {
    setPanel(title)
    dialog.current.showModal()
  }

  return (
    <div className="closing-section">
      <div className="closing-surface">
        <PixelBackground />
        <section className="closing-cta" aria-labelledby="closing-title">
          <p className="closing-label"><span aria-hidden="true">✳</span>Our Feature</p>
          <h2 id="closing-title">One platform.<br /><em>Infinite possibilities.</em></h2>
          <div className="closing-actions">
            <Link className="closing-button closing-button-secondary" to="/#features">See How It Works</Link>
            <button className="closing-button closing-button-primary" onClick={() => openPanel('Book a Demo')}>Book a Demo <span aria-hidden="true">→</span></button>
          </div>
        </section>
        <footer className="site-footer">
          <div className="footer-main">
            <div className="footer-brand-column">
              <Link className="footer-brand" to="/#hero-title"><BrandIcon />Over2u</Link>
              <p>Over2u keeps every project moving with clear,<br className="footer-desktop-break" /> trackable handoffs across your whole team.</p>
              <div className="footer-contact">
                <span>Connect With Us</span>
                <div><a href={`mailto:${contactEmail}`}>{contactEmail}</a></div>
              </div>
            </div>
            {footerColumns.map(({ title, links }) => (
              <nav className="footer-link-column" key={title} aria-label={`${title} links`}>
                <h3>{title}</h3>
                <ul>{links.map(({ label, href }) => <li key={label}>
                  {href ? href.startsWith('#') || href.startsWith('/')
                    ? <Link to={href.startsWith('#') ? `/${href}` : href}>{label}</Link>
                    : <a href={href}>{label}</a>
                    : <button onClick={() => openPanel(label)}>{label}</button>}
                </li>)}</ul>
              </nav>
            ))}
          </div>
          <div className="footer-bottom">
            <p>©2026 Over2u, All Rights Reserved</p>
            <p>Built for seamless project handoffs</p>
            <nav aria-label="Social media">
              {['GitHub', 'LinkedIn', 'X'].map(name => <button key={name} onClick={() => openPanel(name)}>{name}</button>)}
            </nav>
          </div>
        </footer>
      </div>
      <dialog ref={dialog} className="closing-dialog" aria-labelledby="closing-dialog-title" onClick={event => { if (event.target === event.currentTarget) dialog.current.close() }}>
        <button className="closing-dialog-close" aria-label="Close dialog" onClick={() => dialog.current.close()}>×</button>
        <h2 id="closing-dialog-title">{panel}</h2>
        <p>{panel === 'Book a Demo' ? 'Tell us about your team and what you’d like to explore. Email us to arrange a demo.' : `Contact our team for information about ${panel.toLowerCase()}.`}</p>
        <a className="closing-button closing-button-primary" href={`mailto:${contactEmail}?subject=${encodeURIComponent(panel)}`}>{panel === 'Book a Demo' ? 'Request a demo' : 'Contact us'} <span aria-hidden="true">→</span></a>
      </dialog>
    </div>
  )
}
