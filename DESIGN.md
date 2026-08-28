# Egma product design system

This file defines Egma's current product interface. Read it before any visual or interaction change.

The orange-red palette and the Egma logo are locked. Change them only with explicit developer approval.

The styling architecture changed on 2026-08-19 with that approval. **Styling architecture** below is the current truth.

The product's shape changed on 2026-08-23 with that approval, from the Paper file "Egma — Design system and product UI". Five rules moved, and each is marked where it is written: **one radius, and it is 0px**; Egma identity returned to the signed-in sidebar; the **primary action is the wash button**, not a Deep Ember block; **`system-ui` leads the font stack**; and the **side sheet** is where one record is created, read and edited. On 2026-08-24, the approved Paper refinement replaced the full sidebar wordmark with the Egma mark beside organization context and made the account avatar square. The same session's agents-and-tests rework added three rules and changed one: the `*` and `[optional]` label grammar, the Ember top-line on a segmented control's chosen segment, square status markers, and — the one change — **quiet text-field focus**. On 2026-08-26, the run-flow refinement removed decorative markers from settled run states, reserved a spinner for active work, and moved grader verdict meaning into explicit `Result · Passed` or `Result · Failed` text. The palette and the logo's own treatment rules did not move.

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
- `apps/web/public/brand/egma-mark-light.svg`
- `apps/web/public/brand/egma-mark-dark.svg`
- `apps/web/public/brand/egma-wordmark.svg`

Rules:

- Keep the canonical geometry, proportions, and black-and-white treatment.
- Do not recolor, stretch, rotate, outline, shadow, or animate the logo.
- The signed-in sidebar starts with the Egma loop mark beside the current organization and paired arrows, in a 56px bar with a hairline under it. Use the square light/dark mark asset, not the full wordmark. (Developer decision, 2026-08-24, from the approved Paper refinement. The `Free` plan chip left this bar by developer decision, 2026-08-25 on the Paper canvas, implemented the same day.)
- The sidebar mark follows the access pages' existing dark-theme treatment: black line art is printed white by inversion.
- Project context is a separate control under the organization bar. It always shows the word `Project`, the current project name and paired arrows.
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
| Deep Ember | `#c2410c` | The primary action's text, on Ember Wash |
| Ember Hover | `#a93609` | Pointer hover on the primary action's text |
| Ember Pressed | `#872b09` | Pointer press on the primary action's text |
| Ember Wash | `#fff5f2` | The primary action's fill; selected, current, open, cited, and active-attention surfaces |

### Color rules

- The application canvas is Neutral Paper.
- Ordinary borders use a neutral mix of Graphite and Pure Paper.
- Quiet hover, read-only, progress, and supporting surfaces use a neutral Graphite-and-Paper mix.
- Ember is the main brand signal. Use it for focus, icons, marks, and narrow active edges.
- Deep Ember is the primary action's text on Ember Wash. Its contrast on that fill is above 7:1. (Developer decision, 2026-08-23: the filled Deep Ember button with white text is retired.)
- Ember Wash is the primary action's fill, and the surface for selected, current, open, cited, or active-attention states.
- Carbon is for maximum contrast and dark evidence surfaces.
- Body text uses Midnight Ink or Graphite.
- Shadows use restrained orange-brown.
- Focus uses a two-pixel Ember indicator with clear space around it, on every control except a text field.
- **A text field shows focus by its hairline darkening to ink, in place**, and draws no ring. The two-pixel Ember indicator stays on buttons, links, selects, checkboxes, radios, menu items and tabs, which carry no caret and have nothing else to move. The field answers `:focus` rather than `:focus-visible`, because a field clicked into and a field tabbed into are the same field being typed in. (Developer decision, 2026-08-24. This replaces the one-indicator-everywhere rule above it, and it is the only rule in this file that moved with that session.)

### Product state

| State | Light value | Meaning |
| --- | --- | --- |
| Success | `#28775a` | Passed, complete, or healthy |
| Warning | `#9a691c` | Skipped, limited, or needs attention |
| Failure | `#b44444` | Failed, errored, invalid, or destructive |

- Every state includes a word. An icon or shape is optional supporting information, not a second code the reader must learn. Color is supporting information.
- **Run execution status is text first.** `Completed`, `Pending`, and `Canceled` use plain text with no marker. `Running` adds a spinner because motion communicates active work. A failed run may color the word `Failed`; it does not add a decorative marker. On Run Results surfaces, grader verdicts use `Result · Passed` or `Result · Failed`, with color only on the verdict word and no marker. Transcript and simulation evidence badges are the exception: they may carry the shared status marker and follow the next rule. (Developer decision, 2026-08-26, from Paper page `05 — Run flow iterations`; evidence-badge exception clarified 2026-08-27.)
- **A status marker is a square when a marker is useful.** Small static marks that stand for state elsewhere — for example, a step marker beside a transcript line — are squares of the same size, never circles. A failed or errored marker is filled with the semantic Failure colour. Non-failure static markers remain outlines. It follows the one-radius rule rather than sitting outside it, and it keeps the single round shape in the system meaning one thing: a radio button. The run execution status rule above does not change. (Developer decision, 2026-08-24; narrowed for run surfaces on 2026-08-26; failure fill changed by developer decision, 2026-08-27.)
- Brand orange does not mean passed, failed, skipped, or errored.
- Destructive actions use the failure color inside a clear confirmation flow.
- Dark theme uses lighter status values that keep the same meanings.

### Dark theme

- Dark theme uses neutral dark surfaces and the same Ember focus and action family, lightened where a dark surface needs it. The primary action's text is Ember pulled towards paper rather than Deep Ember: Deep Ember on the dark Ember Wash is 2.69:1 and fails AA, and the lighter step is 5.26:1. (Developer decision, 2026-08-23.)
- Dense evidence may use a dark contained surface in either theme.
- Every shared component must support light and dark themes.
- Verify text, borders, focus, status, overlays, and disabled states in both themes.

## Typography

Use `system-ui` first, then Helvetica, Arial, and the system sans-serif fallback. Product text uses weight 400. Weight 500 is reserved for compact labels, important values, and page, section, state, or dialog titles that need stronger hierarchy.

`system-ui` leads because the design boards are rendered in it: Arial first would not draw the product that was approved. (Developer decision, 2026-08-23.)

| Role | Size | Line height | Letter spacing |
| --- | ---: | ---: | ---: |
| Micro label | 12px | 1.5 | 0.08em |
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
- The micro label is for the two letter-spaced uppercase labels the sidebar carries — `Project` over the project name, and the role under the account's email. Nothing else uses it. The scale still starts at 14px.
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
| Every component | 0px |

One radius, and it is none: buttons, inputs, panels, tables, sheets, menus, dialogs, chips, badges. Sharp corners are the product's shape. (Developer decision, 2026-08-23. This replaces the four-step table that named a radius per component type.)

The account avatar is square for every role. (Developer decision, 2026-08-24.)

One round shape remains, and it is not a component corner: a radio button is a circle. The shape is what tells it apart from a checkbox in every operating system, and taking it away would make one control claim to be another.

The four radius names stay in the theme — `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-pill` — because component class lists read them and the name says which component asked. All four are `0px`.

## Elevation

Most structure comes from contrast and borders.

- Menus, side sheets, and dialogs use one shared orange-brown shadow: the two-layer stack below. There is no separate shorter menu shadow; the boards draw all three raised surfaces the same way. (Read off the boards, 2026-08-23.)
- Large showcase panels may use the full orange-brown shadow stack.
- Tables, sidebars, topbars, inputs, search boxes, and ordinary cards do not float. They carry a hairline and nothing else.
- Do not use cool gray shadows.

The shared shadow, worn by every menu, sheet, and dialog:

```css
rgba(122, 49, 23, 0.12) -8px 16px 39px 0,
rgba(122, 49, 23, 0.1) -33px 64px 72px 0
```

The full stack, for a showcase panel:

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
- The organization control is the topmost thing in the sidebar. It holds the Egma mark, organization name and paired arrows in a bar of its own.
- The project selector is a separate control under the organization bar and keeps the word `Project` visible.
- Navigation uses text and small line icons.
- The active item uses Ember Wash and a small Ember mark on its leading edge. Its icon follows the row's text colour; the mark is the brand signal and there is only one.
- The account control stays at the bottom.
- Every page has a title bar of its own, the same height as the wordmark bar, holding the page title alone. A purpose statement, where a form or settings page needs one, is the first quiet line of the page body; list screens carry none (read off the boards, 2026-08-23). Page actions are not in that bar.
- A page below a section carries one uniform trail into its record in that bar, and **the trail is one line that ends with the record** — `Tests / Livekit agent suite`. A page passes the real trail, ending with the record's own name; `PageNavigation` draws that final step as the page's only `h1`. Every segment and separator uses the 14px / 400 step, so the current page never jumps in size or weight. Parent steps are muted links, `/` separates every adjacent step, pointer hover reveals an underline, and keyboard focus uses the standard two-pixel Ember indicator. Page changes are immediate and carry no transition. The bar used to draw the trail short of the record and the record beside it as a larger heading, which read as a small underlined link stuck to a big title with no separator between them. (Developer decision, 2026-08-26, from the selected Paper PageHeader refinement. This replaces the never-repeat-the-title rule read off the boards on 2026-08-23. A page with no trail still draws its title alone in the bar.)
- A page's actions sit in the toolbar row under the title bar, at the right, opposite whatever the page filters by.
- The toolbar row is 52px, and the last 16px of it is the gap to whatever it stands over. The page body adds no gutter of its own under a toolbar row, so a list's panel begins 132px down the page: the 56px title bar, the 24px gutter, and the 52px row. A page whose header draws no toolbar row keeps the 24px gutter, because then nothing above it carries one. (Read off `71N-0` and `6ZM-0` on `6ZJ-0`, 2026-08-23; the application had been drawing the panel at 156.)
- Page content is held to the page maximum and centered when the viewport has spare width. The title bar, toolbar and page body share that frame, so both outer gutters are equal and the title stays aligned with the first column below it. (Developer decision, 2026-08-26, from the Runs alignment review.)
- A run detail is a bounded workbench on desktop. The run facts, simulation list, selected-simulation heading and tab rail stay in place; only the active Results or Transcript panel scrolls. At 900px and below it returns to normal document flow so the stacked run facts do not consume the usable viewport. (Developer decision, 2026-08-26, from the run-detail results review.)

The measurements, all of them theme values:

| Part | Value |
| --- | ---: |
| Sidebar width | 224px |
| Sidebar Egma mark | 32px |
| Sidebar organization bar | 56px |
| Page title bar | 56px |
| Sidebar gutter, page gutter | 16px, 24px |
| Navigation row, toolbar control | 36px |
| Form control, touch target | 44px |
| Table header row | 40px |
| Table body row, minimum | 52px |
| Table row-menu slot | 48px |
| Toolbar row | 52px |
| Side sheet | 440px |

### Organization and project controls

- Keep organization and project as two clear controls. The organization bar shows the Egma mark, organization name and paired arrows. The project control below shows the explicit `Project` label, project name and paired arrows. (Developer decision, 2026-08-24.)
- The organization menu is informational in the current one-organization model. It shows a grey `Organization` label and the organization name. It does not offer organization switching or Organization settings yet. The label is the `Project` label's own recipe, one control down. (Developer decision, 2026-08-25 on the Paper canvas. The `Free Plan` line and the role line left the menu that same day: billing is not in the session read, and the role is already said by the account control at the foot of the same sidebar. The `Organization` label arrived 2026-08-26.)
- The project selector is a direct list with no search field. It keeps the project name neutral when open and continues to support keyboard use, Escape, focus return, URL-based selection, and unsaved-work protection. (Developer decision, 2026-08-24.)
- Open each menu from its trigger with an origin-aware transition.
- Do not add fake teams, sample projects, or a second navigation model.

### Buttons and links

- Primary: Ember Wash fill, Deep Ember text, a one-pixel neutral hairline, no corner. 36px in a toolbar, 44px in a form. (Developer decision, 2026-08-23. The Deep Ember block with white text is retired; no variant draws it.)
- Primary hover and press take one more step of Ember into the fill and the darker Ember steps in the text. The hairline does not move, so the control never looks like it changed size.
- Secondary: transparent with a one-pixel Midnight Ink border.
- Quiet action: text only, with an optional small Ember arrow.
- Destructive actions require confirmation and say what will happen. The action that opens the confirmation is a text action in the failure colour, kept at the far end of a footer from the normal save. The button inside the confirmation is a filled failure-colour button.
- Pointer press feedback uses a subtle scale. Keyboard activation is immediate.
- A link inside a table cell is underlined in the text colour and turns Ember under a pointer.
- **A segmented control's chosen segment carries a two-pixel Ember line on its top edge**, over a plain fill, plus weight 500 so the state is not colour alone. It is the narrow active edge this file already asks Ember for, moved to the edge a person reads first. A wash fill is not used here: the wash is the primary action's own surface, and a segment wearing it reads as a button to press rather than a choice already made. (Developer decision, 2026-08-24.)
- A rail tab at the top of a page or panel carries its two-pixel Ember line on the bottom edge, where the tab meets its content. This does not change the segmented control above. (Developer decision, 2026-08-26, from the run-detail review.)

### Forms and Settings

- Use one clear page title and a short purpose statement.
- Group related fields on Pure Paper surfaces.
- Keep labels visible. Placeholder text is not a label.
- **One label grammar, everywhere.** A mandatory field's label ends in `*`. An optional field's label ends in `[optional]`, in square brackets. A field carries at most one faint help line, and that line says what to write or where the value comes from — never how Egma stores it. (Developer decision, 2026-08-24. The lines that explained storage — “One paste, ever…”, “From your Retell…”, “Off by default…” — were deleted with it.)
- **The star is never only a picture.** A field whose label ends in `*` also carries `aria-required="true"`, so the promise the label makes to a reader is the same one it makes to a screen reader. A starred label with no required semantics is a bug, not a style choice. (Developer decision, 2026-08-24.)
- Save state is truthful: unchanged, saving, saved, or failed.
- Editing after save clears the saved state.
- Protect drafts during link, project, tab, reload, and write-in-flight navigation.
- Keep destructive actions separate from normal save actions.
- Mobile forms use one column and 44px minimum pointer targets.

### Tables and lists

- Use one semantic table tree on desktop and mobile.
- A table is a Pure Paper panel inside one neutral hairline, with its corners clipped.
- Table text starts at 14px.
- Neutral hairlines separate rows. There is no hairline after the last row.
- Headers are quiet, regular-weight labels in a 40px row. A body row is at least 52px.
- Every row ends with the same fixed slot for its row menu, whether or not it has one, so the menus line up in one lane down the table.
- Selected or active rows use Ember Wash plus a non-color state mark.
- Mobile may restyle the same DOM as rows. It must not duplicate interactive content.
- Empty, loading, failed, and filtered-empty are separate states.
- The empty state is a solid Pure Paper card inside one hairline, with 40px of padding, a 16px weight-500 title, one 14px supporting sentence, and the page's action under them as the wash button. It is a fact about the project rather than about egma, so it sits on the page like anything else. Loading, failed, and not-available are interruptions and stay set apart from it. (Read off `AN8-0`, 2026-08-23.)
- A list's date column is the absolute short date — `Aug 16, 2026` — in tabular numerals, with the exact instant kept on the element. A relative age belongs in a sentence ("started just now", "last received 2 min ago") and never in a column: a column of ages cannot be scanned, and two rows a minute apart read the same for the whole of the first hour. One column names a moment rather than a day, and it keeps its precision in the same shape. (Read off `6ZJ-0`, `8TQ-0` and `8P4-0`, 2026-08-23.)

### Run evidence

- Results begin with one compact row above every grader: Total avg score, Duration, Total turns and P90 turn latency. Keep all four facts on one desktop row, stacking each fact's label over its value when the detail pane is narrow. The latency is the platform's recorded `turn_response_latency.p90`, shown in milliseconds with at most three significant digits; mark it as partial when the trace was truncated. Do not repeat the full latency list or the frozen grading plan on this surface; each grader card already carries its definition and pass threshold. (Developer decision, 2026-08-26; metric label renamed by developer decision, 2026-08-27.)
- Expected-behavior tables say `Expected behavior`, `Grader result` and `Total Score`. A grader result is evidence returned by the grader, not a claim about which model produced it. (Developer decision, 2026-08-26.)
- A highlighted transcript event already means it is current. Do not repeat that state with a `Playing` label. Its timestamp remains visible and selecting the event seeks the shared recording. Recording-backed timestamps use the recorded media clock origin when one was captured; historical evidence without that origin stays on its existing trace clock rather than using a guessed offset. (Developer decision, 2026-08-26.)

### Side sheets

- One record is created, read, and edited in a side sheet anchored to the right edge: agents, connections, personas, and tests. The list stays on screen behind it. (Developer decision, 2026-08-23.)
- **There are two side sheets, and they are two behaviours.** The **modal** sheet is the create, read, and edit surface named above: it is 440px, sits over a scrim, and makes the page behind it inert. The **wide reading** sheet is the evidence surface — a transcript beside its grader results, a persona's version history — it is 640px, has no scrim, and deliberately leaves the page beside it usable. A production transcript closes after a primary pointer press on that page. Simulation transcript-and-audio evidence stays open while its grader results are used for comparison. Both widths are theme values. (Developer decision, 2026-08-23; production-transcript outside dismissal added by developer decision, 2026-08-28.)
- A side sheet is full height, on Pure Paper behind a hairline on its left edge.
- Its head is the record's name at the lead step with a close beside it, over a hairline. Its body is the fields and scrolls. Its footer is pinned to the bottom: the answer and the way out at the left, the one destructive action at the right.
- It travels from the edge it is attached to, on the drawer's durations, and fades in place under reduced motion.
- It traps focus, makes the page behind it inert, closes with Escape, and restores the exact opener.

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
