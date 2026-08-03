/* GENERATED FROM tokens.json -- DO NOT EDIT. Run scripts/build-tokens.mjs. */
// Portable design tokens (colors as hex). Web consumes the theme via
// src/index.css; mobile (Expo) and any other platform import this object so the
// whole product shares one source of truth.
export const tokens = {
  "color": {
    "light": {
      "background": "#120B24",
      "foreground": "#F4EEFF",
      "border": "#45356B",
      "card": "#241546",
      "cardForeground": "#F4EEFF",
      "popover": "#1B1035",
      "popoverForeground": "#F4EEFF",
      "primary": "#FF3D71",
      "primaryForeground": "#FFFFFF",
      "secondary": "#2E1A57",
      "secondaryForeground": "#F4EEFF",
      "muted": "#2E1A57",
      "mutedForeground": "#A99BC9",
      "accent": "#C026A8",
      "accentForeground": "#FFFFFF",
      "destructive": "#FF5A6E",
      "destructiveForeground": "#FFFFFF",
      "input": "#1B1035",
      "ring": "#FF3D71",
      "chart1": "#FF3D71",
      "chart2": "#4FE3C4",
      "chart3": "#FFB067",
      "chart4": "#FFD24B",
      "chart5": "#C026A8",
      "sidebar": "#1B1035",
      "sidebarForeground": "#F4EEFF",
      "sidebarBorder": "#45356B",
      "sidebarPrimary": "#FF3D71",
      "sidebarPrimaryForeground": "#FFFFFF",
      "sidebarAccent": "#2E1A57",
      "sidebarAccentForeground": "#F4EEFF",
      "sidebarRing": "#FF3D71"
    },
    "dark": {
      "background": "#120B24",
      "foreground": "#F4EEFF",
      "border": "#45356B",
      "card": "#241546",
      "cardForeground": "#F4EEFF",
      "popover": "#1B1035",
      "popoverForeground": "#F4EEFF",
      "primary": "#FF3D71",
      "primaryForeground": "#FFFFFF",
      "secondary": "#2E1A57",
      "secondaryForeground": "#F4EEFF",
      "muted": "#2E1A57",
      "mutedForeground": "#A99BC9",
      "accent": "#C026A8",
      "accentForeground": "#FFFFFF",
      "destructive": "#FF5A6E",
      "destructiveForeground": "#FFFFFF",
      "input": "#1B1035",
      "ring": "#FF3D71",
      "chart1": "#FF3D71",
      "chart2": "#4FE3C4",
      "chart3": "#FFB067",
      "chart4": "#FFD24B",
      "chart5": "#C026A8",
      "sidebar": "#1B1035",
      "sidebarForeground": "#F4EEFF",
      "sidebarBorder": "#45356B",
      "sidebarPrimary": "#FF3D71",
      "sidebarPrimaryForeground": "#FFFFFF",
      "sidebarAccent": "#2E1A57",
      "sidebarAccentForeground": "#F4EEFF",
      "sidebarRing": "#FF3D71"
    }
  },
  "fontFamily": {
    "sans": [
      "Tajawal",
      "system-ui",
      "sans-serif"
    ],
    "serif": [
      "Tajawal",
      "system-ui",
      "sans-serif"
    ],
    "mono": [
      "ui-monospace",
      "SFMono-Regular",
      "monospace"
    ]
  },
  "radius": "0.875rem",
  "spacing": "0.25rem",
  "brand": {
    "--fatinah-surface-deep": "#120B24",
    "--fatinah-surface-base": "#1B1035",
    "--fatinah-surface-card": "#241546",
    "--fatinah-surface-raised": "#2E1A57",
    "--fatinah-surface-glass": "rgba(255,255,255,0.06)",
    "--fatinah-surface-line": "rgba(255,255,255,0.10)",
    "--fatinah-surface-line-strong": "rgba(255,255,255,0.16)",
    "--fatinah-text-primary": "#F4EEFF",
    "--fatinah-text-muted": "#A99BC9",
    "--fatinah-text-dim": "#7A6BA0",
    "--fatinah-fire-yellow": "#FFD24B",
    "--fatinah-fire-amber": "#FFA836",
    "--fatinah-fire-orange": "#FF7A3D",
    "--fatinah-fire-coral": "#FF4D6A",
    "--fatinah-fire-pink": "#F42B7C",
    "--fatinah-fire-magenta": "#C026A8",
    "--fatinah-fire-hot": "#FF3D71",
    "--fatinah-fire-hot-secondary": "#FF6B35",
    "--fatinah-teams-violet": "#B794FF",
    "--fatinah-teams-teal": "#4FE3C4",
    "--fatinah-teams-peach": "#FFB067",
    "--fatinah-state-success": "#3DDC84",
    "--fatinah-state-error": "#FF5A6E",
    "--fatinah-state-gold": "#FFD24B",
    "--fatinah-gradient-page": "radial-gradient(140% 100% at 50% 0%, #2A1550 0%, #1B1035 45%, #120B24 100%)",
    "--fatinah-gradient-brand": "linear-gradient(120deg, #FFD24B, #FF3D71 55%, #C026A8)",
    "--fatinah-gradient-action": "linear-gradient(120deg, #FF6B35, #FF3D71)",
    "--fatinah-gradient-modal": "linear-gradient(180deg, #241546, #1B1035)",
    "--fatinah-shadow-elevated": "0 10px 40px rgba(0,0,0,0.45)",
    "--fatinah-shadow-hot": "0 8px 24px rgba(255,61,113,0.40)",
    "--fatinah-shadow-focus": "0 0 24px",
    "--fatinah-motion-fast": "120ms",
    "--fatinah-motion-standard": "250ms",
    "--fatinah-motion-entrance": "400ms"
  }
} as const;

export type Tokens = typeof tokens;
export default tokens;
