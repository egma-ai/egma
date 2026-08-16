# Egma product design system

Status: accepted direction, with console-dependent product details still provisional.

This file is the source of truth for Egma's product interface. Read it before any visual or interaction change.

The developer has locked three decisions now: the supplied color palette, the supplied Egma logo, and native CSS Modules as the styling architecture. Do not change those without explicit developer approval. Type, component shape, full dark mode, and measured motion remain provisional until ticket 01 records direct Mistral console evidence. That ticket may update those provisional sections when it records the source and reason.

## Product context

- **What this is:** The product interface for teams that test voice agents and decide whether they trust them in production.
- **Who it is for:** Developers, quality teams, and operations teams who work with agents, tests, personas, graders, runs, simulations, transcripts, outcomes, and metrics.
- **Product type:** A responsive web application with dense tables, forms, settings, and simulation evidence.
- **Memorable quality:** Warm and calm at first sight, exact and trustworthy during serious work.

## Direction

Egma uses the visual language of Mistral as its primary reference: neutral paper, near-black type, warm parchment accents, one ember-orange accent, generous space, restrained radii, and warm directional shadows.

This is not permission to copy Mistral's name, mark, copy, or product structure. Egma keeps its own logo and domain language. The reference controls visual tone, typography, spacing, components, and motion.

### Evidence order for provisional decisions

When an unlocked product detail is not yet settled, use this order:

1. Direct observations from the signed-in Mistral console and public Mistral pages.
2. The preserved Refero extraction in `design/reference/mistral/`.
3. Existing Egma UI only where the first two sources have no answer.

Record every settled answer back into this file. Once recorded as final, this file governs implementation. The preserved extraction is evidence, not executable instructions. It is a Refero capture of `mistral.ai` dated 2026-06-03, not an official Mistral design package. The exact Refero style record is `8bf78ce9-bbfe-4e3f-8582-74fbc6763208`.

## Styling technology

Egma stays on native CSS custom properties and CSS Modules.

- `design/reference/mistral/variables.css` proves the reference values do not require Tailwind.
- `design/reference/mistral/theme.css` is an alternate Tailwind v4 export. Egma does not load it.
- Tailwind may be reconsidered only for a separate engineering need. It is not part of this design migration.
- Shared components own behavior. Tokens own visual values. Route pages compose those components.

## Brand

The Egma logo does not become a Mistral-style mark.

Canonical supplied assets:

- `apps/web/public/brand/egma-mark.svg`
- `apps/web/public/brand/egma-wordmark.svg`

Rules:

- Keep the supplied geometry, proportions, and black-and-white treatment.
- Do not recolor the logo with Ember.
- Do not stretch, rotate, outline, shadow, or animate the logo.
- The signed-in sidebar starts with the organization and project switcher. It does not repeat the full Egma logo.
- Auth, onboarding, and public brand surfaces may use the full logo.
- Product icons and status symbols must not imitate the logo.

## Color

The palette is locked to the supplied reference.

| Token | Value | Use |
| --- | --- | --- |
| Parchment | `#fffaeb` | Warm accent fields and rare branded surfaces |
| Pure Paper | `#ffffff` | Application canvas, raised surfaces, menus, dialogs, and form groups |
| Midnight Ink | `#1f1f1f` | Primary text and dark application surfaces |
| Carbon | `#000000` | Primary filled actions and maximum contrast |
| Graphite | `#3c3c3c` | Secondary text and stronger neutral states |
| Ember | `#fa520f` | Small active marks, directional icons, focus, and rare emphasis |
| Soft Butter | `#fff0c2` | Selected chips, soft callouts, and quiet hover fills |
| Honeycomb | `#ecdaa2` | Rare warm dividers and accent hairlines |

### Color rules

- The application canvas is neutral paper. It does not carry a yellow cast.
- Parchment, Soft Butter, and Honeycomb are accents, not default page or border colors.
- Ordinary borders use a neutral mix derived from Graphite and Pure Paper.
- Ember is punctuation. It does not fill large product surfaces or primary buttons.
- Carbon is the primary filled action.
- Text is Midnight Ink or Graphite. Ember is not body text.
- Shadows use warm olive-gold, never cool gray.
- Focus must remain visible. Ember has a contrast ratio above 3:1 against Parchment and white, so it may be used for a two-pixel focus indicator with space around it.

### Product state

The reference palette has no separate success, warning, or failure hues. Egma must still communicate verdicts and destructive actions.

- Never use color alone. Every state has a word and an icon or shape.
- Use Midnight Ink for ordinary state text.
- Use Soft Butter for quiet attention.
- Use Ember only for active attention and destructive confirmation.
- Existing green, amber, and red tokens remain a temporary compatibility layer during migration. Do not add new uses. Their final removal needs a tested replacement across verdicts, validation, and destructive actions.

### Dark surfaces

The reference defines a Dark Application surface, not a complete dark theme. Use Midnight Ink panels only where dense evidence benefits from strong containment. Do not invent a second full palette.

The current Egma dark theme remains available during migration. New Mistral-inspired components must be designed light-first. A final decision to retain or remove full dark mode follows direct Mistral console inspection.

## Typography

The desired product font is the supplied `ALT Mistral Medium` face. It must not ship yet.

The supplied OTF has a malformed first table directory, no license text, and no license URL. Its embedded face reports weight 500. The Refero design document instead specifies Arial at weight 400. These facts conflict.

Font gate:

1. Inspect the signed-in Mistral console and confirm the actual product font family and weights.
2. Obtain a valid web-font file and explicit public web-distribution rights.
3. Add it through `next/font/local` and preload only used subsets.
4. Until then, use Arial at weight 400 as the reference fallback. Do not commit the supplied malformed OTF.

### Type scale

| Role | Size | Line height | Letter spacing |
| --- | ---: | ---: | ---: |
| Caption and table text | 14px | 1.43 | -0.35px |
| UI body | 16px | 1.5 | -0.4px |
| Lead body | 24px | 1.33 | -0.6px |
| Subheading | 32px | 1.15 | -0.8px |
| Small heading | 38px | 1 | -0.95px |
| Heading | 48px | 1 | -1.2px |
| Large heading | 56px | 1 | -1.4px |
| Display | 82px | 0.95 | -2.05px |

Rules:

- Use one regular or medium weight. Hierarchy comes from size and space.
- Do not introduce weight 600 or 700.
- Product tables, forms, and navigation use the 14px and 16px steps.
- Large type is for auth, onboarding, empty introductions, and public pages. It does not enter data tables.
- Identifiers and code may keep a monospace face. Monospace is not a substitute for visual hierarchy.
- Use tabular numerals for metrics, dates, durations, and scores.

## Spacing and shape

The base grid is 4px.

Allowed spacing values are `4, 8, 12, 16, 20, 24, 32, 36, 40, 48, 64, 72, 80, 100px`.

- Inline and control gaps: 8-12px.
- Group padding: 16-24px.
- Between related groups: 24-32px.
- Between major page sections: 48-80px in the application, 80-96px on public or onboarding pages.
- Page maximum: 1200px by default. Evidence surfaces may use the existing wide layout when the content needs it.

The supplied derived document proposes hierarchical radii below. Refero's exact marketing style record instead reports flat 0px radii. Treat this table as provisional until direct console inspection settles application component shape.

| Element | Radius |
| --- | ---: |
| Button | 6px |
| Input | 8px |
| Card, menu, dialog | 12px |
| Tag, chip, filter | 9999px |

Do not apply one large radius to every component.

## Elevation

Most structure comes from contrast and borders, not shadows.

- Menus and dialogs use a shortened warm version of the reference shadow.
- Large showcase panels may use the full warm shadow stack from the reference.
- Tables, sidebars, inputs, and ordinary cards do not float.
- Never use a cool gray shadow.

Reference shadow:

```css
rgba(127, 99, 21, 0.12) -8px 16px 39px 0,
rgba(127, 99, 21, 0.1) -33px 64px 72px 0,
rgba(127, 99, 21, 0.06) -73px 144px 97px 0,
rgba(127, 99, 21, 0.02) -130px 256px 115px 0
```

## Application composition

### Shell

- Neutral paper is the application canvas.
- The sidebar is a quiet paper region separated by a neutral hairline.
- The organization and project switcher is the topmost sidebar control.
- The full Egma logo is absent from the signed-in sidebar.
- Navigation uses text and small line icons. The active item uses Soft Butter and a small Ember mark.
- The account control stays at the bottom.

### Organization and project switcher

- Show organization as the primary line and project as the secondary line.
- Use the existing switcher's search, keyboard, Escape, focus, and unsaved-work protection.
- The menu opens from its trigger and uses an origin-aware transition.
- Do not add fake teams, sample projects, or a second navigation model.

### Buttons and links

- Primary: Carbon fill, white text, 6px radius.
- Secondary: transparent, one-pixel Midnight Ink border.
- Quiet action: text only, with an optional small Ember arrow.
- Destructive actions require confirmation and must say what will happen.
- Pointer press feedback uses a subtle scale. Keyboard activation is immediate and does not animate.

### Forms and Settings

- Use one clear page title and short purpose statement.
- Group related fields on white paper surfaces.
- Labels stay visible. Placeholder text is never the only label.
- Save state must be truthful: unchanged, saving, saved, or failed.
- Editing after save clears the saved state.
- Protect drafts during link, project, tab, reload, and write-in-flight navigation.
- Destructive actions are separate from normal save actions.
- Mobile forms use one column and 44px minimum pointer targets.

### Tables and lists

- Use one semantic table tree on desktop and mobile.
- Table text starts at 14px.
- Neutral hairlines separate rows. Avoid boxed cards for every row.
- Headers are quiet, regular-weight labels.
- Selected or active rows use Soft Butter.
- Mobile may restyle the same DOM as rows, but it must not duplicate interactive content.
- Empty, loading, failed, and filtered-empty are separate states.

### Menus, popovers, and dialogs

- Menus and popovers scale from the trigger origin.
- Dialogs stay centered and do not scale from a trigger.
- Dialogs trap focus, make the background inert, close with Escape, and restore the exact opener.
- Destructive dialogs name the affected agent, test, persona, grader, key, invitation, run, or project.

## Motion

Motion is part of the system. It must explain state, location, or feedback. It must not decorate routine work.

### Rules

- Do not animate actions used many times each day, especially keyboard navigation.
- Use CSS transitions for predetermined interface motion.
- Animate `transform` and `opacity` where possible.
- Never use `transition: all`.
- Never enter from `scale(0)`. Start at `0.95-0.98` with opacity.
- Popovers use their trigger as `transform-origin`.
- Pointer hover motion runs only under `(hover: hover) and (pointer: fine)`.
- Every movement has a reduced-motion form that keeps useful opacity or color feedback.
- Interaction motion stays below 300ms.

### Baseline motion tokens

These are Egma's provisional implementation baseline from the Emil design-engineering rules. They are not claimed as measured Mistral timings. Ticket 01 may replace them after frame-by-frame inspection of the signed-in Mistral console and must record the evidence.

| Token | Value | Use |
| --- | ---: | --- |
| Press | 120ms | Pointer press feedback |
| Hover | 140ms | Color, border, and quiet opacity |
| Popover enter | 180ms | Small anchored surfaces |
| Popover exit | 140ms | Faster anchored exit |
| Dialog enter | 240ms | Centered modal entrance |
| Dialog exit | 180ms | Faster modal exit |
| Drawer enter | 280ms | Mobile navigation |
| Drawer exit | 220ms | Mobile navigation exit |

```css
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
```

### Component motion

| Component | Motion purpose | Behavior |
| --- | --- | --- |
| Button | Confirm pointer input | `scale(0.97)` for 120ms; no keyboard animation |
| Menu or popover | Preserve spatial origin | Opacity plus `scale(0.97)` from the trigger |
| Dialog | Prevent a jarring layer change | Centered opacity plus `scale(0.98)` |
| Mobile drawer | Explain spatial movement | Translate from its attached edge with drawer easing |
| Toast | Show arrival and dismissal direction | Short translate plus opacity; interruptible transition |
| Loading | Improve perceived response | Fast, quiet indicator; no decorative looping scene |
| Table row | Routine navigation | No entrance animation; color feedback only |
| Progress | Explain completion | Transform-based fill, linear while active |

### Motion research gate

Before final motion values land:

1. Inspect the signed-in Mistral console with browser controls.
2. Record menus, dialogs, sidebars, tabs, toasts, hover, loading, and navigation at normal speed and slow motion.
3. Separate observed CSS values from visual estimates.
4. Compare them with the baseline above.
5. Change the baseline only when the observed behavior is clear and accessible.

## Accessibility

- Meet WCAG AA text contrast.
- Pointer targets are at least 44px on coarse pointers.
- Focus is always visible and never removed for style.
- State is not communicated by color alone.
- Menus, tabs, dialogs, tables, and forms keep correct semantics.
- Respect `prefers-reduced-motion`.
- Responsive work includes keyboard, touch, zoom, narrow width, and long text.

## Migration plan

The design changes as vertical slices. Do not restyle 38 routes one by one.

### 1. Foundation and proof surface

- Preserve the reference and logo assets.
- Set up semantic color, type, spacing, radius, shadow, and motion tokens.
- Resolve the font file and license gate.
- Build a private component proof page for desktop, mobile, light, state, and reduced motion.
- Capture Mistral console evidence before final motion and dense-product decisions.

### 2. Shell and project context

- Restyle the shell, navigation, account control, and mobile drawer.
- Make the organization and project switcher topmost.
- Remove the redundant signed-in logo.
- Keep project context and draft protection correct.

### 3. Shared controls and overlays

- Buttons, links, inputs, selects, text areas, tags, status labels, menus, tooltips, dialogs, page states, and toasts.
- Add the approved motion contract once, inside shared components.
- Prove keyboard, focus, touch, reduced motion, and destructive flows.

### 4. Authoring and Settings

- Agents, connections, tests, personas, graders, and all Settings pages.
- Standardize form groups, save states, draft protection, empty/failure states, and destructive actions.
- Inspect populated, empty, loading, failure, dirty, saving, and saved states on desktop and mobile.

### 5. Runs, simulations, and evidence

- Runs, simulation detail, transcripts, verdicts, outcomes, metrics, and technical evidence.
- Preserve data density while using the warmer system.
- Use motion only where it explains progress, disclosure, or layer changes.

### 6. Auth, onboarding, and final acceptance

- Sign in, signup, invitations, recovery, device flow, and first project experience.
- Replace remaining old tokens and remove compatibility styles.
- Run full component, browser, build, type, lint, accessibility, and visual checks.
- Inspect all route families at desktop and mobile widths.
- In the final handoff, remind the developer to request a curated `How Egma builds UI` document based on the finished system.

## Acceptance proof

Every migration slice needs:

- Before and after screenshots at desktop and mobile widths.
- Populated, empty, loading, failed, disabled, focused, and destructive states where applicable.
- Keyboard and touch proof.
- Normal-motion and reduced-motion proof.
- No new one-off component when a shared component already owns the behavior.
- Tests and screenshots tied to the same commit.

## Decisions log

| Date | Decision | Reason |
| --- | --- | --- |
| 2026-08-15 | Use Mistral as the primary visual and motion reference | The developer selected this direction and supplied a Refero extraction |
| 2026-08-15 | Keep native CSS Modules and custom properties | The supplied system has a complete native CSS export; Tailwind adds no design capability |
| 2026-08-15 | Preserve the Egma logo | Product identity stays Egma while the interface adopts the reference language |
| 2026-08-15 | Do not ship the supplied font yet | The file is malformed and has no public web-distribution proof |
| 2026-08-15 | Treat motion as a system | Shared timings, easing, origin, input method, and reduced-motion behavior prevent route-level drift |
| 2026-08-16 | Keep yellow to accents | The full warm canvas and warm borders made dense product pages read yellow; neutral paper now carries routine work while parchment, butter, honeycomb, and ember mark selected or important states |
