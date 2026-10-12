import { useState } from 'react'
import './TestimonialsFaq.css'

// Reference copy is kept here so individual cards can be edited independently.
const testimonials = [
  {
    name: 'Anita Mandeley',
    role: 'CEO Mondrian Corp',
    portrait: 'anita',
    quote: "Cygnus didn't just replace our project tool, it replaced three of them. Our team finally has one source of truth, and I finally have visibility into what's actually moving the company forward.",
  },
  {
    name: 'Gianlucca Mescarra',
    role: 'Co-Founder Hello Earth',
    portrait: 'gianlucca',
    quote: "As a founder wearing ten hats, I needed something that thinks ahead. Cygnus does. It plans the week, flags what's slipping, and somehow knows what I'll forget before I forget it.",
  },
  {
    name: 'Fransisca Romana',
    role: 'CEO Arctics Project',
    portrait: 'fransisca',
    quote: 'We scaled from 12 to 80 people in a year, and Cygnus scaled with us. Automations that used to take a Friday to set up now take five minutes. Our ops team genuinely loves it.',
  },
]

const questions = [
  {
    question: 'How is Cygnus different from other tools?',
    answer: 'Most tools added AI as an afterthought. Cygnus was built around it. Our engine learns how your team works and proactively handles the busywork, no prompts required.',
  },
  {
    question: 'Is My Data Secure?',
    answer: 'See the security and privacy information for details on how workspace data is handled, who can access it, and the protections available to your team.',
  },
  {
    question: 'Can I import data from another tool?',
    answer: 'Import options depend on the tool you use and the format of your data. Contact our team with your current setup to discuss the best way to move your workspace.',
  },
  {
    question: 'What does AI access include in each plan?',
    answer: 'Check the plan details for included AI features and usage limits. Our team can help you compare the options for your workspace.',
  },
  {
    question: 'Do you offer discounts for nonprofits or education?',
    answer: 'Contact our team with information about your organization to ask about nonprofit and education pricing.',
  },
  {
    question: 'Can I cancel anytime?',
    answer: 'Cancellation terms depend on your subscription. Review your plan’s billing terms for cancellation dates and any remaining commitments.',
  },
]

function SectionLabel({ children }) {
  return <p className="trust-label"><span aria-hidden="true">✳</span>{children}</p>
}

function CustomerPortrait({ person }) {
  return (
    <div className={`customer-portrait customer-${person}`} aria-hidden="true">
      <span className="customer-hair-back" />
      <span className="customer-shirt" />
      <span className="customer-neck" />
      <span className="customer-face"><i /><i /><span /></span>
      <span className="customer-hair-front" />
    </div>
  )
}

function Testimonials() {
  return (
    <section className="testimonials-section" aria-labelledby="testimonials-title">
      <header className="testimonials-heading">
        <SectionLabel>Loved by Teams</SectionLabel>
        <h2 className="trust-serif" id="testimonials-title">Loved by teams.<br /><span>Trusted by leaders.</span></h2>
        <p className="testimonials-description">From scrappy startups to scaling enterprises, teams everywhere are shipping<br className="trust-desktop-break" /> faster with Cygnus. Here’s what they have to say.</p>
      </header>
      <div className="testimonial-grid">
        {testimonials.map(({ name, role, portrait, quote }) => (
          <figure className="testimonial-card" key={name}>
            <CustomerPortrait person={portrait} />
            <blockquote>{quote}</blockquote>
            <figcaption><span className="customer-name">{name}</span><span className="customer-role">{role}</span></figcaption>
          </figure>
        ))}
      </div>
    </section>
  )
}

function Faq() {
  const [openQuestion, setOpenQuestion] = useState(0)

  return (
    <section className="faq-section" aria-labelledby="faq-title" id="faq">
      <div className="faq-intro">
        <div>
          <SectionLabel>Frequently Asked Question</SectionLabel>
          <h2 className="trust-serif" id="faq-title">Every Common Question<br /><span>Captured Here</span></h2>
        </div>
        <p className="faq-description">Everything you need to know about Cygnus, from how our AI works to pricing and security. Can’t find what you’re looking for? Our team is one message away.</p>
      </div>
      <div className="faq-list">
        {questions.map(({ question, answer }, index) => {
          const isOpen = openQuestion === index
          return (
            <article className={`faq-item ${isOpen ? 'faq-item-open' : ''}`} key={question}>
              <h3>
                <button
                  id={`faq-question-${index}`}
                  aria-expanded={isOpen}
                  aria-controls={`faq-answer-${index}`}
                  onClick={() => setOpenQuestion(isOpen ? null : index)}
                >
                  <span>{question}</span>
                  <span className="faq-toggle" aria-hidden="true">{isOpen ? '−' : '+'}</span>
                </button>
              </h3>
              <div id={`faq-answer-${index}`} role="region" aria-labelledby={`faq-question-${index}`} hidden={!isOpen}>
                <p>{answer}</p>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

export default function TestimonialsFaq() {
  return <div className="trust-section"><div className="trust-inner"><Testimonials /><Faq /></div></div>
}
