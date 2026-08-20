# Egma product design system

This file defines Egma's current product interface. Read it before any visual or interaction change.

The orange-red palette and the Egma logo are locked. Change them only with explicit developer approval.

The styling architecture changed on 2026-08-19 with that approval. **Styling architecture** below is the current truth.

## Product context

- **What this is:** The product interface for teams that test voice agents and decide whether they trust them in production.
- **Who it is for:** Developers, quality teams, and operations teams who work with agents, tests, personas, graders, runs, simulations, transcripts, outcomes, and metrics.
- **Product type:** A responsive web application with dense tables, forms, settings, and simulation evidence.
- **Memorable quality:** Warm and calm at first sight, exact and trustworthy during serious work.

## Design principles

- Use neutral paper, near-black type, one orange-red brand family, generous space, restrained radii, and warm directional shadows.
- Keep dense product evidence easy to scan. Decoration must not compete with transcripts, verdicts, metrics, or outcomes.
- Make every state truthful. Loading, empty, failed, disabled, saving, saved, skipped, and errored states must say what happened.
- Use Egma's domain terms exactly: agent, test, test suite, run, simulation, grader, persona, transcript, outcome, and metric.
- Build responsive, keyboard, touch, reduced-motion, light-theme, and dark-theme behavior as one system.
- Every component is clean, modern, and slick. Clean is nothing on the surface that carries no meaning. Modern is the current shape of the web: exact alignment, one clear focus, honest depth, and no ornament that imitates another medium. Slick is a component that looks finished at every width and in every state, including empty, loading, failed, and disabled. This raises the standard. It unlocks nothing: the palette, the logo, and every rule in this file stay as written. (Developer decision, 2026-08-19.)

## Styling architecture

shadcn/ui on Tailwind is the component base. Build new components on it.

The developer approved this on 2026-08-19, with the conflict on the table: this
section said "Do not introduce Tailwind," and shadcn/ui ships on Tailwind. The
architecture unlocked. The palette and the logo did not.

**This file stays the single source of theme values.** Tailwind holds no value of
its own. It is given egma's values by reference, so a Tailwind surface and a CSS
Modules surface read one declaration instead of two copies of it.

Where the pieces live:

- `apps/web/ui/tailwind-theme.css` owns shared visual values, including the derived ones such as a status chip's edge and the dialog scrim, and hands them to Tailwind in the same file. Change a value here and nowhere else. The values are declared in an unlayered `:root`; the `@theme` keys below them are each a `var()` into one of those declarations and hold no value of their own. The unlayered part is load-bearing: five names are declared twice — `--radius-sm`, `--radius-md`, `--radius-lg`, `--ease-out` and `--ease-in-out` — and being outside every layer is what makes egma's value win each one. Moving the declarations into `@theme` would hand all five back to Tailwind.
- `apps/web/components/ui/` holds the shadcn primitives. Add one with the shadcn CLI; `components.json` points it at the right places.
- `apps/web/ui/` holds the shared components built from those primitives — the table, the dialog, the menu, the form, the shell.
- `apps/web/lib/utils.ts` holds `cn`, which every primitive merges a caller's classes with.
- `apps/web/app/globals.css` is the one stylesheet the application loads.
- No CSS Module remains in the application. The last one, `app/ui.module.css`, dressed the transcript detail page and retired with that page's migration onto the base — its own change with its own render-test proof, as this section once promised.

Rules:

- Use semantic tokens such as `--action`, `--surface-active`, and `--border` outside the theme file.
- Do not put a color, a radius, a size, or a duration in a component. Read it from the theme.
- Where shadcn has a default and this file has a rule, this file decides. The theme removes the scales this file has no value for, so no class exists for a weight above 500, a cool gray shadow, a radius belonging to no component, or a type step outside the scale below.
- Tailwind's fixed utilities are not scale entries and cannot be removed that way. A few are still generated, because Tailwind finds class names by reading files as text and a comment that contains the word `table` mints `.table`. They are applied to nothing.
- Do not start a new component in CSS Modules.
- Route pages compose shared components and add only route-specific layout.
- Do not add a one-off component when a shared component already owns the behavior.

## Brand

Canonical assets:

- `apps/web/public/brand/egma-mark.svg`
- `apps/web/public/brand/egma-wordmark.svg`

Rules:

- Keep the canonical geometry, proportions, and black-and-white treatment.
- Do not recolor, stretch, rotate, outline, shadow, or animate the logo.
- The signed-in sidebar starts with the organization and project switcher. It does not repeat the full Egma logo.
- Auth, onboarding, and public brand surfaces may use the full logo.
- Product icons and status symbols must not imitate the logo.

## Color

Egma uses neutral paper surfaces and one orange-red brand family. Routine product surfaces do not use gradients.

| Token | Value | Use |
| --- | --- | --- |
| Neutral Paper | 3% Graphite mixed with Pure Paper | Application canvas |
| Pure Paper | `#ffffff` | Raised surfaces, menus, dialogs, and form groups |
| Midnight Ink | `#1f1f1f` | Primary text and dark application surfaces |
| Carbon | `#000000` | Maximum contrast and rare dark application surfaces |
| Graphite | `#3c3c3c` | Secondary text and stronger neutral states |
| Ember | `#ff5229` | Brand accent, focus, active marks, and directional icons |
| Deep Ember | `#c2410c` | Primary filled actions with white text |
| Ember Hover | `#a93609` | Pointer hover on primary filled actions |
| Ember Pressed | `#872b09` | Pointer press on primary filled actions |
| Ember Wash | `#fff5f2` | Selected, current, open, cited, and active-attention surfaces |

### Color rules

- The application canvas is Neutral Paper.
- Ordinary borders use a neutral mix of Graphite and Pure Paper.
- Quiet hover, read-only, progress, and supporting surfaces use a neutral Graphite-and-Paper mix.
- Ember is the main brand signal. Use it for focus, icons, marks, and narrow active edges.
- Deep Ember is the primary filled action. Its white-text contrast is above 5:1.
- Ember Wash is for selected, current, open, cited, or active-attention states.
- Carbon is for maximum contrast and dark evidence surfaces.
- Body text uses Midnight Ink or Graphite.
- Shadows use restrained orange-brown.
- Focus uses a two-pixel Ember indicator with clear space around it.

### Product state

| State | Light value | Meaning |
| --- | --- | --- |
| Success | `#28775a` | Passed, complete, or healthy |
| Warning | `#9a691c` | Skipped, limited, or needs attention |
| Failure | `#b44444` | Failed, errored, invalid, or destructive |

- Every state includes a word and an icon or shape. Color is supporting information.
- Brand orange does not mean passed, failed, skipped, or errored.
- Destructive actions use the failure color inside a clear confirmation flow.
- Dark theme uses lighter status values that keep the same meanings.

### Dark theme

- Dark theme uses neutral dark surfaces and the same Ember focus and action family.
- Dense evidence may use a dark contained surface in either theme.
- Every shared component must support light and dark themes.
- Verify text, borders, focus, status, overlays, and disabled states in both themes.

## Typography

Use Arial, Helvetica, and the system sans-serif fallback. Product text uses weight 400. Weight 500 is reserved for compact labels, important values, and page, section, state, or dialog titles that need stronger hierarchy.

| Role | Size | Line height | Letter spacing |
| --- | ---: | ---: | ---: |
| Caption and table text | 14px | 1.43 | -0.35px |
| UI body | 16px | 1.5 | -0.4px |
| Lead body | 24px | 1.33 | -0.6px |
| Subheading | 32px | 1 | -0.8px |
| Small heading | 38px | 1 | -0.95px |
| Heading | 48px | 1 | -1.2px |
| Large heading | 56px | 1 | -1.4px |
| Display | 82px | 1 | -2.05px |

Rules:

- Hierarchy comes from size, space, and restrained use of weight 500.
- Do not use weights 600 or 700.
- Product tables, forms, and navigation use the 14px and 16px steps.
- Headings carry no size of their own. Every heading takes its size from a class, because the browser's own heading sizes are not on this scale.
- Large type is for auth, onboarding, empty introductions, and public pages.
- Identifiers and code use the shared monospace stack.
- Metrics, dates, durations, and scores use tabular numerals.
- Add a web font only when its public distribution rights are explicit.

## Spacing and shape

The base grid is 4px.

Allowed spacing values are `4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 72, 80, 100px`.

- Inline and control gaps: 8-12px.
- Group padding: 16-24px.
- Between related groups: 24-32px.
- Between major application sections: 48-80px.
- Between major public or onboarding sections: 80-100px.
- Page maximum: 1200px.
- Evidence surfaces may use the 1440px wide layout when the content needs it.

| Element | Radius |
| --- | ---: |
| Button | 6px |
| Input | 8px |
| Card, menu, dialog | 12px |
| Tag, chip, filter | 9999px |

Use each radius for its named component type. Do not apply one large radius to every component.

## Elevation

Most structure comes from contrast and borders.

- Menus and dialogs use the shared short orange-brown shadow.
- Large showcase panels may use the full orange-brown shadow stack.
- Tables, sidebars, inputs, and ordinary cards do not float.
- Do not use cool gray shadows.

```css
rgba(122, 49, 23, 0.12) -8px 16px 39px 0,
rgba(122, 49, 23, 0.1) -33px 64px 72px 0,
rgba(122, 49, 23, 0.06) -73px 144px 97px 0,
rgba(122, 49, 23, 0.02) -130px 256px 115px 0
```

## Application composition

### Shell

- Neutral Paper is the application canvas.
- The sidebar is a quiet paper region separated by a neutral hairline.
- The organization and project switcher is the topmost sidebar control.
- The full Egma logo is absent from the signed-in sidebar.
- Navigation uses text and small line icons.
- The active item uses Ember Wash and a small Ember mark.
- The account control stays at the bottom.

### Organization and project switcher

- Show organization as the primary line and project as the secondary line.
- Support search, keyboard use, Escape, focus return, and unsaved-work protection.
- Open the menu from its trigger with an origin-aware transition.
- Do not add fake teams, sample projects, or a second navigation model.

### Buttons and links

- Primary: Deep Ember fill, white text, and 6px radius.
- Primary hover and press use the darker Ember steps.
- Secondary: transparent with a one-pixel Midnight Ink border.
- Quiet action: text only, with an optional small Ember arrow.
- Destructive actions require confirmation and say what will happen.
- Pointer press feedback uses a subtle scale. Keyboard activation is immediate.

### Forms and Settings

- Use one clear page title and a short purpose statement.
- Group related fields on Pure Paper surfaces.
- Keep labels visible. Placeholder text is not a label.
- Save state is truthful: unchanged, saving, saved, or failed.
- Editing after save clears the saved state.
- Protect drafts during link, project, tab, reload, and write-in-flight navigation.
- Keep destructive actions separate from normal save actions.
- Mobile forms use one column and 44px minimum pointer targets.

### Tables and lists

- Use one semantic table tree on desktop and mobile.
- Table text starts at 14px.
- Neutral hairlines separate rows.
- Headers are quiet, regular-weight labels.
- Selected or active rows use Ember Wash plus a non-color state mark.
- Mobile may restyle the same DOM as rows. It must not duplicate interactive content.
- Empty, loading, failed, and filtered-empty are separate states.

### Menus, popovers, and dialogs

- Menus and popovers scale from the trigger origin.
- Dialogs stay centered.
- Dialogs trap focus, make the background inert, close with Escape, and restore the exact opener.
- Destructive dialogs name the affected agent, test, persona, grader, key, invitation, run, or project.

## Motion

Motion explains state, location, or feedback. It does not decorate routine work.

Motion is fast, modern, and slick. Fast is the shortest duration that still
explains the change, and short enough that nothing waits for it. Modern is
`transform` and `opacity`, composited. Slick is one movement that starts where
the person is looking and ends where the content is. This raises the standard.
The rules below are the floor and do not move. (Developer decision, 2026-08-19.)

### Rules

- Do not animate actions used many times each day, especially keyboard navigation.
- Use CSS transitions for predetermined interface motion.
- Animate `transform` and `opacity` where possible.
- Never use `transition: all`.
- Start small-surface scale transitions at `0.95-0.98`.
- Popovers use their trigger as `transform-origin`.
- Pointer hover motion runs only under `(hover: hover) and (pointer: fine)`.
- Every movement has a reduced-motion form with useful opacity or color feedback.
- Interaction motion stays below 300ms.
- Choose the shorter token when two would both explain the change.
- An exit runs to completion and is never cut off. A surface that is closed finishes leaving before it is removed.
- No motion delays input. A control answers on press, not after an animation.

### Motion tokens

| Token | Value | Use |
| --- | ---: | --- |
| Press | 120ms | Pointer press feedback |
| Hover | 140ms | Color, border, and quiet opacity |
| Popover enter | 180ms | Small anchored surfaces |
| Popover exit | 140ms | Anchored exit |
| Dialog enter | 240ms | Centered modal entrance |
| Dialog exit | 180ms | Centered modal exit |
| Drawer enter | 280ms | Mobile navigation |
| Drawer exit | 220ms | Mobile navigation exit |

```css
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
```

### Component motion

| Component | Purpose | Behavior |
| --- | --- | --- |
| Button | Confirm pointer input | `scale(0.97)` for 120ms; no keyboard animation |
| Menu or popover | Preserve spatial origin | Opacity plus `scale(0.97)` from the trigger |
| Dialog | Explain a modal layer | Centered opacity plus `scale(0.98)` |
| Mobile drawer | Explain spatial movement | Translate from its attached edge |
| Toast | Show arrival and dismissal | Short translate plus opacity; interruptible transition |
| Loading | Show progress | Fast, quiet indicator |
| Table row | Support routine navigation | Color feedback only |
| Navigation row | Support routine navigation | Color feedback only |
| Progress | Explain completion | Transform-based fill, linear while active |

## Accessibility

- Meet WCAG AA text contrast.
- Pointer targets are at least 44px on coarse pointers.
- Focus is always visible.
- State is not communicated by color alone.
- Menus, tabs, dialogs, tables, and forms keep correct semantics.
- Respect `prefers-reduced-motion`.
- Responsive work includes keyboard, touch, zoom, narrow width, and long text.

## Verification

Every visual or interaction change needs proof that matches its risk:

- Current-state screenshots at desktop and mobile widths.
- Light-theme and dark-theme checks for shared visual changes.
- Populated, empty, loading, failed, disabled, focused, and destructive states where applicable.
- Keyboard, touch, normal-motion, and reduced-motion checks where applicable.
- No new one-off component when a shared component owns the behavior.
- Focused tests, type checks, and a production build for shared-system changes.
- Code checks and screenshots tied to the same commit.
