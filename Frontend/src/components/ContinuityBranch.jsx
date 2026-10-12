export default function ContinuityBranch() {
  return (
    <svg
      className="continuity-branch"
      viewBox="0 0 110 260"
      fill="none"
      aria-hidden="true"
    >
      <path d="M26 0V260M88 190V260" stroke="#eee4dc" strokeWidth="3" />
      <path
        d="M26 66V208M26 110C26 155 88 120 88 170V208"
        stroke="#30251f"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <g stroke="#30251f" strokeWidth="3">
        <circle cx="26" cy="66" r="19" fill="#ffd2a6" />
        <path d="m26 58 8 8-8 8-8-8Z" fill="white" />
        <circle cx="26" cy="208" r="19" fill="#ffd2a6" />
        <path d="M19 201h14v14H19Z" fill="white" />
        <circle cx="88" cy="208" r="19" fill="#ff6b35" />
        <circle cx="88" cy="208" r="6" fill="white" />
      </g>
    </svg>
  )
}
