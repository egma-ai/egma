# Frontier AI LLMs — Style Reference
> warm parchment with a campfire heart

**Theme:** light

Mistral's visual system reads as a sunlit workshop on warm paper — a cream-ivory canvas (#fffaeb) that feels like aged parchment, generously padded with a single vivid orange (#fa520f) doing all the chromatic talking. The hero erupts into a dramatic amber landscape gradient with mountain silhouettes, then everything afterward returns to that quiet, warm, almost tactile quietness. Typography stays in a clean system sans (Arial) with tight -0.025em tracking that tightens the lines into one confident whisper. The system has an unusual visual signature: warm-toned shadows tinted in olive-gold rather than cool gray, giving every elevated element a 'lit from within by firelight' quality. Density is comfortable and confident, not dense — breathing room is part of the brand. The product mockups in the body break into dark UI panels floating on the cream, creating contrast between the paper-warm site shell and the structured dark application surfaces.

## Tokens — Colors

| Name | Value | Token | Role |
|------|-------|-------|------|
| Parchment Canvas | `#fffaeb` | `--color-parchment-canvas` | Page background, hero body, section fills — warm cream-ivory that replaces the typical white SaaS canvas and gives the system its sunlit, paper-like quality |
| Pure Card | `#ffffff` | `--color-pure-card` | Card surfaces, elevated panels, feature blocks, and product mockup shells — pure white that reads brighter than the canvas and creates a subtle paper-on-paper layering |
| Midnight Ink | `#1f1f1f` | `--color-midnight-ink` | Primary body text, headings, nav links, button text — near-black rather than pure black keeps text from feeling harsh against the warm canvas |
| Carbon | `#000000` | `--color-carbon` | Dark supporting neutral for text, icons, and strong contrast. Do not promote it to the primary CTA color |
| Graphite | `#3c3c3c` | `--color-graphite` | Secondary text, button hover borders, muted supporting copy |
| Ember | `#fa520f` | `--color-ember` | Brand accent — decorative arrow icons, the flag mark, section punctuation, active indicators; vivid orange against warm cream creates urgency without aggression and is the only chromatic voice in the interface |
| Soft Butter | `#fff0c2` | `--color-soft-butter` | Yellow supporting accent for decorative details and low-frequency emphasis. Do not promote it to the primary CTA color |
| Honeycomb | `#ecdaa2` | `--color-honeycomb` | Warm hairlines, decorative block borders, subtle dividers that need to be visible against the cream canvas without breaking the warm palette |

## Tokens — Typography

### Arial — All text — a single-weight system sans that ships in the browser. The 82px display with -0.025em tracking and 0.95 line-height gives headlines a sculpted, almost condensed feel without actually condensing. Because weight stays at 400, hierarchy comes purely from size and tracking — this is deliberate restraint: no weight-700 shouts, just scale. · `--font-arial`
- **Substitute:** Helvetica, Inter, system-ui
- **Weights:** 400
- **Sizes:** 14px, 16px, 24px, 32px, 38px, 48px, 56px, 82px
- **Line height:** 0.95-1.50
- **Letter spacing:** -0.025em across all sizes (tightest at 82px display, normalizing through body sizes)
- **Role:** All text — a single-weight system sans that ships in the browser. The 82px display with -0.025em tracking and 0.95 line-height gives headlines a sculpted, almost condensed feel without actually condensing. Because weight stays at 400, hierarchy comes purely from size and tracking — this is deliberate restraint: no weight-700 shouts, just scale.

### Type Scale

| Role | Size | Line Height | Letter Spacing | Token |
|------|------|-------------|----------------|-------|
| caption | 14px | 1.43 | -0.35px | `--text-caption` |
| body-sm | 16px | 1.5 | -0.4px | `--text-body-sm` |
| body | 24px | 1.33 | -0.6px | `--text-body` |
| subheading | 32px | 1.15 | -0.8px | `--text-subheading` |
| heading-sm | 38px | 1 | -0.95px | `--text-heading-sm` |
| heading | 48px | 1 | -1.2px | `--text-heading` |
| heading-lg | 56px | 1 | -1.4px | `--text-heading-lg` |
| display | 82px | 0.95 | -2.05px | `--text-display` |

## Tokens — Spacing & Shapes

**Base unit:** 4px

**Density:** comfortable

### Spacing Scale

| Name | Value | Token |
|------|-------|-------|
| 4 | 4px | `--spacing-4` |
| 8 | 8px | `--spacing-8` |
| 12 | 12px | `--spacing-12` |
| 16 | 16px | `--spacing-16` |
| 20 | 20px | `--spacing-20` |
| 24 | 24px | `--spacing-24` |
| 32 | 32px | `--spacing-32` |
| 36 | 36px | `--spacing-36` |
| 40 | 40px | `--spacing-40` |
| 48 | 48px | `--spacing-48` |
| 64 | 64px | `--spacing-64` |
| 72 | 72px | `--spacing-72` |
| 80 | 80px | `--spacing-80` |
| 100 | 100px | `--spacing-100` |

### Border Radius

| Element | Value |
|---------|-------|
| tags | 9999px |
| cards | 12px |
| inputs | 8px |
| buttons | 6px |

### Shadows

| Name | Value | Token |
|------|-------|-------|
| xl | `rgba(127, 99, 21, 0.12) -8px 16px 39px 0px, rgba(127, 99,...` | `--shadow-xl` |

### Layout

- **Page max-width:** 1200px
- **Section gap:** 80-96px
- **Card padding:** 24px
- **Element gap:** 12px

## Components

### Top Navigation Bar
**Role:** Site-wide header

Sticky top bar on #fffaeb canvas. Left: Ember M-flag logo. Center: nav links (Products, Solutions, Research, Blog, Customers, Company) in 16px Arial weight 400, #1f1f1f, with 24px gaps. Right: ghost 'Contact Sales' button (transparent fill, 1px #1f1f1f border, 6px radius, 16px 20px padding) followed by filled 'Try Studio' button (#000000 fill, white text, 6px radius, 16px 20px padding) with a trailing chevron. Height ~64px. No drop shadow — sits flush on canvas.

### Hero Landscape Banner
**Role:** Above-the-fold brand statement

Full-bleed 82px display headline 'Frontier AI. In your hands.' in #1f1f1f over an amber landscape gradient. The background uses the multi-stop warm gradient (olive → amber → rust) with mountain silhouette overlays, creating a campfire-at-dusk atmosphere. Subhead at 24px weight 400, body text at 16px. Two ghost text links ('Get in touch', 'Start building') with trailing arrow icons in #fa520f sit at 48-80px below the headline.

### Enterprise Logo Strip
**Role:** Social proof band

Full-width row of monochrome partner logos (IBM, ASML, HSBC, Cisco, Teleperformance, SAP) on #fffaeb canvas, centered, with equal 48px column gaps. Logos rendered in #1f1f1f only — no brand colors from the partners survive. This neutralization is a deliberate brand-strengthening move: the partners lend credibility but don't compete with the visual identity.

### Split Feature Section
**Role:** Mid-page value proposition

Two-column layout. Left: large heading at 48px ('Your AI future belongs in your hands.') followed by a decorative block-grid pattern of #fff0c2 rectangles that echo Tetris-like shapes. Right: vertically stacked feature blocks, each with a small Ember arrow icon, a 32px subheading, and 16px body text in #1f1f1f. Feature blocks separated by 32px vertical gaps with no dividers — breathing room does the structuring.

### Product Capability Section
**Role:** Feature deep-dive with UI showcase

Two-column with heading on the left and stacked dark-mode product mockups on the right. Background is a faint grid pattern (#fff0c2 hairlines at 10% opacity) over the cream canvas. Left side features a 56px heading ('Autonomous work.') with 16px body text, a vertical stack of 3 Soft Butter tag pills (Workflow automation, Enterprise search, Content creation) at 9999px radius, and a filled #000000 CTA button 'Discover Le Chat' with trailing Ember arrow.

### Ghost Text Button
**Role:** Secondary action / inline link

No background, no border. 16px Arial weight 400, #1f1f1f text, with a trailing 12px Ember arrow icon (→). Underline appears on hover. Used for inline actions like 'Get in touch', 'Start building', feature list headers. The arrow becomes the visual anchor — text is just a label for the direction.

### Filled Dark Button
**Role:** Primary action

#000000 background, #ffffff text, 6px border-radius, 16px vertical / 20px horizontal padding, 16px Arial weight 400. May carry a trailing chevron-down for dropdown variants. Used sparingly: 'Try Studio' in nav, 'Discover Le Chat' in feature sections. The deep black against the warm cream creates the highest contrast on the page — these buttons are anchors, not decorations.

### Ghost Outline Button
**Role:** Tertiary action

Transparent background, 1px #1f1f1f border, 6px radius, 16px/20px padding, 16px Arial weight 400 in #1f1f1f. Hover: fills to #fff0c2. Used for 'Contact Sales' — the gentler sibling that invites conversation without competing with the primary black button beside it.

### Soft Butter Pill
**Role:** Filter, tag, or category label

#fff0c2 background, #1f1f1f text, 9999px border-radius, 8px vertical / 12px horizontal padding, 14px Arial weight 400. May include a trailing checkmark icon. Used as a row of capability tags in the Autonomous work section. The pill radius contrasts intentionally with the 6px button radius — pills feel soft and categorical, buttons feel precise and actionable.

### Feature List Item
**Role:** Scannable value-proposition block

Vertical stack: 12px Ember right-arrow icon → 32px heading in #1f1f1f → 16px body text in #1f1f1f. 32px gap between items. No borders or backgrounds — the eyebrow icon is the only chromatic element, and it appears as a small spark of intent at the start of each block.

### Dark Product Mockup Panel
**Role:** Application UI showcase

Dark #1f1f1f panel with 12px radius, floating on the cream canvas. Contains simulated chat/file list interfaces with white text, colored file-type icons (xlsx in green, pdf in red — but these are product content, not design system tokens). Warm-toned shadow: rgba(127, 99, 21, 0.12) -8px 16px 39px with cascading layers extending to -130px 256px 115px at 0.02 alpha. The olive-gold shadow tint makes the dark panel feel lit by the same firelight as the hero.

### Decorative Block Grid
**Role:** Visual texture in feature sections

A pattern of #fff0c2 rectangles of varying sizes arranged in a loose grid/Tetris composition, sitting behind or beside heading text. No interactivity, no content. This is the system's playful signature — it turns empty layout space into brand character, the way Stripe uses gradient meshes or Linear uses dotted grids.

## Do's and Don'ts

### Do
- Use #fffaeb as the default page background — never pure white for full-page canvas; white is reserved for card surfaces that need to lift off the parchment.
- Let the Ember orange (#fa520f) appear only as small functional punctuation: arrow icons, the M-mark, active indicators, and small accent shapes. It should never fill large surfaces except the hero landscape.
- Keep all type at weight 400 — hierarchy comes from size and tracking, not from bolding. Headlines whisper; they do not shout.
- Apply -0.025em letter-spacing at every size; the tracking tightens the system sans into something that feels custom-sculpted even though it ships in the browser.
- Use the warm shadow stack (tinted in rgba(127, 99, 21, 0.x)) for all elevated elements — never use cool gray shadows; they would break the campfire palette.
- Set button radius at 6px and tag radius at 9999px — the contrast between crisp buttons and soft pills is part of the visual vocabulary.
- Stack 12px gaps within groups, 32px between groups, 80-96px between sections. The breathing room is the brand — do not pack it dense.

### Don't
- Do not introduce new chromatic colors — the system is cream + black + one orange. Any new hue dilutes the signature.
- Do not use weight 600 or 700 — the entire typographic system runs on 400 with size-driven hierarchy; introducing bold breaks the anti-shout aesthetic.
- Do not use cool gray shadows (#000000 with low alpha) — always tint shadows in the warm olive-gold hue (127, 99, 21) to stay on-palette.
- Do not use 9999px radius on buttons or cards — reserve pill radius exclusively for tags, chips, and filter labels.
- Do not fill the Ember orange as a button background — it is a brand accent, not an action color. The only filled button color is #000000.
- Do not use pure #ffffff as a page background — the warm canvas (#fffaeb) is the system's defining surface; white pages feel clinical by comparison.
- Do not stack more than two type sizes in a single block — the hierarchy must read at a glance through size jumps, not through cumulative scaling.

## Surfaces

| Level | Name | Value | Purpose |
|-------|------|-------|---------|
| 0 | Parchment Canvas | `#fffaeb` | Page background — the warm cream-ivory that replaces white and defines the system's sunlit character |
| 1 | Pure Card | `#ffffff` | Product UI shells, elevated feature cards, mockup containers — brighter than the canvas to read as 'lifted off the page' |
| 2 | Butter Tag | `#fff0c2` | Highlight surfaces — selected filter chips, active tags, soft callouts that need a third tonal step |
| 3 | Dark Application | `#1f1f1f` | In-app product mockups and dark UI panels floating on the cream — the structured application surface contrasted against the warm marketing shell |

## Elevation

- **Dark Product Mockup Panel:** `rgba(127, 99, 21, 0.12) -8px 16px 39px 0px, rgba(127, 99, 21, 0.1) -33px 64px 72px 0px, rgba(127, 99, 21, 0.06) -73px 144px 97px 0px, rgba(127, 99, 21, 0.02) -130px 256px 115px 0px`

## Imagery

The site uses three imagery modes in sequence: (1) a full-bleed warm landscape gradient with mountain silhouettes as the hero, establishing the campfire palette; (2) decorative #fff0c2 block-grid patterns that function as abstract texture in feature sections — never photographic, always geometric and soft; (3) dark product UI mockups floating on the cream canvas, showing chat interfaces and file lists as proof of the actual product. There is no lifestyle photography, no people, no stock imagery. The only 'real world' image is the hero landscape, and even that is illustrated/silhouetted, not photographed. Iconography is minimal: the Ember M-mark as a custom flag shape, small right-arrow chevrons for actions, and simple line icons inside the product mockups. Everything else is typographic and structural.

## Layout

Layout is max-width 1200px centered for all content blocks, with the hero breaking to full-bleed. The page rhythm follows a consistent pattern: (1) full-bleed warm hero with centered-or-left-aligned headline, (2) a white-on-cream partner logo band, (3) split sections alternating between left-text/right-feature-list and left-text/right-product-mockup, (4) 80-96px vertical breathing room between sections, no alternating dark bands — the entire post-hero page stays on the cream canvas. Navigation is a single sticky top bar. The site uses a 2-column split for all mid-page sections; no 3-column card grids. The autonomous-work section introduces a faint background grid pattern (#fff0c2 hairlines) to add texture without breaking the palette. Content arrangement is text-left dominant, with the right column always carrying either a list or a dark product surface.

## Agent Prompt Guide

**Quick Color Reference**
- text: #1f1f1f
- background: #fffaeb
- surface (card): #ffffff
- border: #ecdaa2
- accent: #fa520f (Ember orange — icons, arrows, flag mark only)
- tag/highlight: #fff0c2
- primary action: no distinct CTA color

**3-5 Example Component Prompts**

1. **Hero section**: Full-bleed warm landscape gradient (amber/rust mountain silhouettes). Headline at 82px Arial weight 400, #1f1f1f, letter-spacing -2.05px, line-height 0.95, text 'Frontier AI. In your hands.' Two ghost text links below at 16px: 'Get in touch →' and 'Start building →', each with a 12px Ember orange arrow.

2. **Product capability section**: Background #fffaeb with a faint #fff0c2 grid pattern overlay. Left column: 56px heading 'Autonomous work.' in #1f1f1f, 16px body text, a vertical stack of three Soft Butter pills (#fff0c2, 9999px radius, 14px text in #1f1f1f, trailing checkmark), then a filled #000000 button 'Discover Le Chat' with trailing Ember arrow. Right column: a dark #1f1f1f product mockup panel with 12px radius, warm-tinted shadow stack (rgba(127, 99, 21, 0.12) etc.), containing white text chat/file list UI.

3. **Feature list block**: Right column of a split section. 32px vertical stack of 4 items. Each item: 12px Ember right-arrow icon, 32px subheading in #1f1f1f, 16px body text in #1f1f1f, 32px gap to next item. No borders, no backgrounds, no card containers.

4. **Top navigation bar**: 64px height on #fffaeb canvas. Left: Ember M-flag mark. Center: nav links (Products ▾, Solutions ▾, Research ▾, Blog ▾, Customers ▾, Company ▾) at 16px Arial weight 400, #1f1f1f, 24px gaps. Right: ghost outline button 'Contact Sales' (transparent, 1px #1f1f1f border, 6px radius) beside filled #000000 button 'Try Studio ▾' (white text, 6px radius).

5. **Ghost outline button** (e.g. Contact Sales): transparent background, 1px #1f1f1f border, 6px radius, 16px vertical / 20px horizontal padding, 16px Arial weight 400 #1f1f1f text. Hover state: background fills to #fff0c2.

## Shadow Philosophy

Every shadow in the system is tinted in warm olive-gold (rgba(127, 99, 21, x)) rather than neutral black. The cascading four-layer stack extends from -8px/-130px offsets with alpha descending from 0.12 to 0.02, creating long, low-intensity directional shadows. This is the system's most distinctive technical choice: a dark panel floating on warm paper should cast a shadow that looks like it was lit by the same campfire, not by a fluorescent ceiling.

## Similar Brands

- **Stripe** — Both use a restrained palette with one vivid accent, generous whitespace, and tight tracking on headlines — but Mistral swaps Stripe's cool blue gradient for warm cream and amber.
- **Linear** — Similar display headlines with tight -0.025em tracking and a single-weight sans approach, though Linear's violet/indigo accent becomes Mistral's ember orange.
- **Vercel** — Both let one strong typographic voice carry the hero with minimal UI chrome, but Mistral's warm parchment canvas replaces Vercel's pure white/grayscale palette.
- **Notion** — Both have a paper-like canvas feel and use decorative geometric blocks (Notion's shapes, Mistral's #fff0c2 Tetris grids) as visual texture in feature sections.

## Quick Start

### CSS Custom Properties

```css
:root {
  /* Colors */
  --color-parchment-canvas: #fffaeb;
  --color-pure-card: #ffffff;
  --color-midnight-ink: #1f1f1f;
  --color-carbon: #000000;
  --color-graphite: #3c3c3c;
  --color-ember: #fa520f;
  --color-soft-butter: #fff0c2;
  --color-honeycomb: #ecdaa2;

  /* Typography — Font Families */
  --font-arial: 'Arial', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;

  /* Typography — Scale */
  --text-caption: 14px;
  --leading-caption: 1.43;
  --tracking-caption: -0.35px;
  --text-body-sm: 16px;
  --leading-body-sm: 1.5;
  --tracking-body-sm: -0.4px;
  --text-body: 24px;
  --leading-body: 1.33;
  --tracking-body: -0.6px;
  --text-subheading: 32px;
  --leading-subheading: 1.15;
  --tracking-subheading: -0.8px;
  --text-heading-sm: 38px;
  --leading-heading-sm: 1;
  --tracking-heading-sm: -0.95px;
  --text-heading: 48px;
  --leading-heading: 1;
  --tracking-heading: -1.2px;
  --text-heading-lg: 56px;
  --leading-heading-lg: 1;
  --tracking-heading-lg: -1.4px;
  --text-display: 82px;
  --leading-display: 0.95;
  --tracking-display: -2.05px;

  /* Typography — Weights */
  --font-weight-regular: 400;

  /* Spacing */
  --spacing-unit: 4px;
  --spacing-4: 4px;
  --spacing-8: 8px;
  --spacing-12: 12px;
  --spacing-16: 16px;
  --spacing-20: 20px;
  --spacing-24: 24px;
  --spacing-32: 32px;
  --spacing-36: 36px;
  --spacing-40: 40px;
  --spacing-48: 48px;
  --spacing-64: 64px;
  --spacing-72: 72px;
  --spacing-80: 80px;
  --spacing-100: 100px;

  /* Layout */
  --page-max-width: 1200px;
  --section-gap: 80-96px;
  --card-padding: 24px;
  --element-gap: 12px;

  /* Named Radii */
  --radius-tags: 9999px;
  --radius-cards: 12px;
  --radius-inputs: 8px;
  --radius-buttons: 6px;

  /* Shadows */
  --shadow-xl: rgba(127, 99, 21, 0.12) -8px 16px 39px 0px, rgba(127, 99, 21, 0.1) -33px 64px 72px 0px, rgba(127, 99, 21, 0.06) -73px 144px 97px 0px, rgba(127, 99, 21, 0.02) -130px 256px 115px 0px;

  /* Surfaces */
  --surface-parchment-canvas: #fffaeb;
  --surface-pure-card: #ffffff;
  --surface-butter-tag: #fff0c2;
  --surface-dark-application: #1f1f1f;
}
```

### Tailwind v4

```css
@theme {
  /* Colors */
  --color-parchment-canvas: #fffaeb;
  --color-pure-card: #ffffff;
  --color-midnight-ink: #1f1f1f;
  --color-carbon: #000000;
  --color-graphite: #3c3c3c;
  --color-ember: #fa520f;
  --color-soft-butter: #fff0c2;
  --color-honeycomb: #ecdaa2;

  /* Typography */
  --font-arial: 'Arial', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;

  /* Typography — Scale */
  --text-caption: 14px;
  --leading-caption: 1.43;
  --tracking-caption: -0.35px;
  --text-body-sm: 16px;
  --leading-body-sm: 1.5;
  --tracking-body-sm: -0.4px;
  --text-body: 24px;
  --leading-body: 1.33;
  --tracking-body: -0.6px;
  --text-subheading: 32px;
  --leading-subheading: 1.15;
  --tracking-subheading: -0.8px;
  --text-heading-sm: 38px;
  --leading-heading-sm: 1;
  --tracking-heading-sm: -0.95px;
  --text-heading: 48px;
  --leading-heading: 1;
  --tracking-heading: -1.2px;
  --text-heading-lg: 56px;
  --leading-heading-lg: 1;
  --tracking-heading-lg: -1.4px;
  --text-display: 82px;
  --leading-display: 0.95;
  --tracking-display: -2.05px;

  /* Spacing */
  --spacing-4: 4px;
  --spacing-8: 8px;
  --spacing-12: 12px;
  --spacing-16: 16px;
  --spacing-20: 20px;
  --spacing-24: 24px;
  --spacing-32: 32px;
  --spacing-36: 36px;
  --spacing-40: 40px;
  --spacing-48: 48px;
  --spacing-64: 64px;
  --spacing-72: 72px;
  --spacing-80: 80px;
  --spacing-100: 100px;

  /* Shadows */
  --shadow-xl: rgba(127, 99, 21, 0.12) -8px 16px 39px 0px, rgba(127, 99, 21, 0.1) -33px 64px 72px 0px, rgba(127, 99, 21, 0.06) -73px 144px 97px 0px, rgba(127, 99, 21, 0.02) -130px 256px 115px 0px;
}
```
