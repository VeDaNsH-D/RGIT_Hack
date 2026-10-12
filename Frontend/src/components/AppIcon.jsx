// Individual vector icons sit in HTML tiles. The cards and diagrams are CSS layouts.
export default function AppIcon({ name }) {
  switch (name) {
    case 'meta':
      return <svg viewBox="0 0 40 40"><path d="M20 23C12 2 5 6 3 23c-2 14 8 12 17-4C30 2 37 8 38 23c1 13-9 13-18-4" fill="none" stroke="#0087f8" strokeWidth="3.5" strokeLinecap="round"/></svg>
    case 'basecamp':
      return <svg viewBox="0 0 40 40"><path d="M5 29 13 11q7-7 14 0l9 18q-14 13-31 0" fill="#a8e5bd" stroke="#a9dbf6" strokeWidth="3"/><path d="m10 27 7-10 5 5 5-3 5 9" fill="#72c887"/><path d="m15 27 3 3 3-3m3 0 3 3 3-3" stroke="#285344" strokeWidth="1.8" fill="none"/></svg>
    case 'clickup':
      return <svg viewBox="0 0 40 40"><defs><linearGradient id="clickup-top"><stop stopColor="#f875d1"/><stop offset="1" stopColor="#ffdb79"/></linearGradient><linearGradient id="clickup-bottom"><stop stopColor="#b97bed"/><stop offset="1" stopColor="#9dddf5"/></linearGradient></defs><path d="m7 17 13-11 13 11" stroke="url(#clickup-top)" strokeWidth="7" fill="none"/><path d="M7 27q13 13 26 0" stroke="url(#clickup-bottom)" strokeWidth="7" fill="none"/></svg>
    case 'zendesk-gray':
      return <svg viewBox="0 0 40 40" fill="#7c7e79"><path d="M3 8h16L3 26V8Zm18 24h16L21 14v18ZM3 32h16V14L3 32ZM21 8h16L21 26V8Z"/></svg>
    case 'notion':
      return <svg viewBox="0 0 40 40"><path d="m6 7 22-3 6 6v24L11 37l-5-6Zm0 0 5 6 23-3M11 13v24" fill="none" stroke="#202422" strokeWidth="2" /><text x="15" y="30" fontFamily="Georgia, serif" fontWeight="bold" fontSize="23" fill="#202422">N</text></svg>
    case 'slack':
      return <svg viewBox="0 0 40 40"><g strokeWidth="7" strokeLinecap="round"><path d="M16 6v10M6 16h4" stroke="#36c5f0"/><path d="M34 16H24M24 6v4" stroke="#2eb67d"/><path d="M24 34V24M34 24h-4" stroke="#ecb22e"/><path d="M6 24h10M16 34v-4" stroke="#e01e5a"/></g></svg>
    case 'monday':
      return <svg viewBox="0 0 40 40"><g strokeWidth="9" strokeLinecap="round"><path d="m8 25 7-12" stroke="#f43c65"/><path d="m21 25 7-12" stroke="#ffcb00"/></g><circle cx="34" cy="27" r="4" fill="#00c875"/></svg>
    case 'evernote':
      return <svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="19" fill="#00ad22"/><path d="M13 12h5l4-3 7 4v16c-2 5-10 3-10-1h5v-5l-6 2c-7-1-10-5-8-10l3-3Zm0 0v6h6" fill="white"/><circle cx="25" cy="17" r="1.5" fill="#00ad22"/></svg>
    case 'loom':
      return <svg viewBox="0 0 40 40"><g stroke="#7059f5" strokeWidth="3.5">{Array.from({ length: 12 }, (_, i) => <path key={i} d="M20 2v10" transform={`rotate(${i * 30} 20 20)`}/>)}</g><circle cx="20" cy="20" r="4" fill="#7059f5"/></svg>
    case 'trello':
      return <svg viewBox="0 0 40 40"><rect x="1" y="1" width="38" height="38" rx="5" fill="#2585f8"/><rect x="6" y="6" width="11" height="28" rx="2" fill="white"/><rect x="23" y="6" width="11" height="18" rx="2" fill="white"/></svg>
    case 'todoist':
      return <svg viewBox="0 0 40 40"><rect width="40" height="40" rx="5" fill="#e94432"/><path d="m5 12 8 4 19-10M5 20l8 4 19-10M5 28l8 4 19-10" stroke="white" strokeWidth="2" fill="none"/></svg>
    case 'asana':
      return <svg viewBox="0 0 40 40"><defs><linearGradient id="asana-color" x2="0" y2="1"><stop stopColor="#f95487"/><stop offset="1" stopColor="#ff765e"/></linearGradient></defs><circle cx="20" cy="20" r="19" fill="url(#asana-color)"/><g fill="#fff4c3"><circle cx="20" cy="14" r="5"/><circle cx="14" cy="24" r="5"/><circle cx="26" cy="24" r="5"/></g></svg>
    case 'drive':
      return <svg viewBox="0 0 40 40"><path d="m16 5 9 0 14 25-9 0Z" fill="#3784df"/><path d="M16 5 2 30l5 8 14-25Z" fill="#34a853"/><path d="M7 38h28l4-8H12Z" fill="#fbbc04"/></svg>
    case 'mailchimp':
      return <svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="#ffe01b"/><path d="M11 17c-3 0-4 5-1 8 0 9 18 10 22 1 2-4-2-7-7-7 4-6 1-10-4-8-5-3-12 0-10 6Zm4 8c5 3 9 3 14 0M16 16l5 1m-9-5 2-5 12 1 2 4" fill="none" stroke="#171713" strokeWidth="1.5"/><circle cx="22" cy="20" r="1.5"/></svg>
    case 'zendesk':
      return <svg viewBox="0 0 40 40" fill="#16a474"><path d="M4 7h15v15L4 7Zm17 0h15v15L21 7ZM4 25l15-15v23H4Zm17-7 15 15H21V18Z"/></svg>
    case 'aws':
      return <svg viewBox="0 0 40 40"><text x="3" y="24" fontFamily="Arial" fontSize="17" fill="#243039">aws</text><path d="M3 29q17 10 32 0m-6 0 6-1-1 5" stroke="#f5a000" strokeWidth="1.8" fill="none"/></svg>
    case 'airtable':
      return <svg viewBox="0 0 40 40"><path d="m20 5 16 7-16 7-16-7Z" fill="#ffbf00"/><path d="m3 15 15 7v14L3 28Z" fill="#f94466"/><path d="m21 22 16-7v14l-16 7Z" fill="#18bfff"/></svg>
    case 'zapier':
      return <svg viewBox="0 0 40 40"><g stroke="#ff4f00" strokeWidth="5"><path d="M20 3v12m0 10v12M3 20h12m10 0h12M8 8l9 9m6 6 9 9M8 32l9-9m6-6 9-9"/></g><rect x="16" y="16" width="8" height="8" fill="#ff4f00"/></svg>
    default:
      return null
  }
}

