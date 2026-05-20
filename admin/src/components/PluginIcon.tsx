const PluginIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width="2em"
    height="2em"
    aria-hidden="true"
    focusable="false"
  >
    {/* Image frame — scaled to fill the viewBox */}
    <rect
      x="1" y="1.5" width="16.5" height="13.5" rx="2"
      fill="none" stroke="currentColor" strokeWidth="1.5"
    />
    {/* Sun */}
    <circle cx="5" cy="6" r="1.5" fill="currentColor" />
    {/* Mountain */}
    <path
      d="M1.5 13.5 L5.5 8.5 L8.5 11.5 L11.5 8 L17 13.5 Z"
      fill="currentColor"
    />
    {/* W badge — large circle anchored to bottom-right corner */}
    <circle cx="18" cy="18" r="6" fill="currentColor" />
    {/* W letter inside badge */}
    <path
      d="M13.5 15 L15 21.5 L18 17 L21 21.5 L22.5 15"
      fill="none" stroke="white" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round"
    />
  </svg>
);

export { PluginIcon };
