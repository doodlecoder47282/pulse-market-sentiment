export default function Logo({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 28 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Pulse"
      className={className}
    >
      {/* concentric pulse rings */}
      <circle cx="14" cy="14" r="3" fill="currentColor" />
      <circle cx="14" cy="14" r="7" stroke="currentColor" strokeWidth="1.5" opacity="0.55" />
      <circle cx="14" cy="14" r="12" stroke="currentColor" strokeWidth="1" opacity="0.25" />
      {/* ticker line through center */}
      <path d="M0 14 L8 14 L10 9 L13 19 L16 11 L18 14 L28 14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity="0.9" />
    </svg>
  );
}
