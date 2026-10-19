// Small inline icons for the bottom tab bar. They inherit the text colour.
const common = {
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export const AgentsIcon = () => (
  <svg {...common}>
    <rect x="4" y="4" width="7" height="7" rx="2" />
    <rect x="13" y="4" width="7" height="7" rx="2" />
    <rect x="4" y="13" width="7" height="7" rx="2" />
    <rect x="13" y="13" width="7" height="7" rx="2" />
  </svg>
);

export const LiveIcon = () => (
  <svg {...common}>
    <polyline points="3,12 8,12 11,5 14,19 17,12 21,12" />
  </svg>
);

export const PromptIcon = () => (
  <svg {...common}>
    <path d="M4 5h16v11H10l-5 4v-4H4z" />
  </svg>
);

export const ProjectIcon = () => (
  <svg {...common}>
    <path d="M3 7a2 2 0 012-2h5l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
  </svg>
);

export const HistoryIcon = () => (
  <svg {...common}>
    <circle cx="12" cy="12" r="8" />
    <polyline points="12,7 12,12 15,14" />
  </svg>
);
