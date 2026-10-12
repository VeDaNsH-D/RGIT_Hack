export default function ContinuityBranch() {
  return (
    <svg
      className="continuity-branch"
      viewBox="0 0 110 260"
      fill="none"
      aria-hidden="true"
    >
      <path d="M26 0V260M88 190V260" stroke="#e9eceb" strokeWidth="3" />
      <path
        d="M26 66V208M26 110C26 155 88 120 88 170V208"
        stroke="#202925"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <g stroke="#202925" strokeWidth="3">
        <circle cx="26" cy="66" r="19" fill="#d8c8ef" />
        <path d="m26 58 8 8-8 8-8-8Z" fill="white" />
        <circle cx="26" cy="208" r="19" fill="#d8c8ef" />
        <path d="M19 201h14v14H19Z" fill="white" />
        <circle cx="88" cy="208" r="19" fill="#a9dfca" />
        <circle cx="88" cy="208" r="6" fill="white" />
      </g>
    </svg>
  )
}
