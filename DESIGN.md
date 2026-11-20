---
name: msum
description: A light, monochrome local control panel that frames the digest exactly as it lands in your own chat.
colors:
  primary: "#1d1d1f"
  primary-ink: "#ffffff"
  ground: "#ffffff"
  ground-2: "#f5f5f7"
  surface: "#ffffff"
  bubble: "#f5f5f7"
  rail: "#f5f5f7"
  rail-hover: "rgba(0, 0, 0, 0.045)"
  rail-active: "rgba(0, 0, 0, 0.075)"
  line: "#e5e5ea"
  line-strong: "#d2d2d7"
  ink: "#1d1d1f"
  ink-2: "#515154"
  mute: "#6e6e73"
  avatar: "#e5e5ea"
  avatar-ink: "#515154"
  ok: "#2e7d5b"
  ok-bg: "#e8f5ee"
  bad: "#b4412f"
  bad-bg: "#fdecea"
  bad-ink: "#7a2c1c"
  warn: "#8a5a00"
  warn-bg: "#fbf0d9"
  focus: "#1d1d1f"
  sel: "#d9d9de"
  dot-ok: "#2e7d5b"
  dot-bad: "#b4412f"
  dot-busy: "#c08a1e"
  dot-idle: "#a1a1a6"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  stat:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    letterSpacing: "-0.01em"
    fontFeature: "tnum"
  brand:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 650
    letterSpacing: "-0.02em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  bubble:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.5
  caption:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
  micro:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.5
  tag:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: 1.5
  mono:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
rounded:
  xs: "6px"
  sm: "8px"
  md: "10px"
  segmented: "11px"
  lg: "12px"
  xl: "14px"
  sheet: "16px"
  bubble: "16px"
  full: "999px"
spacing:
  xxs: "4px"
  xs: "6px"
  sm: "8px"
  snug: "10px"
  md-minus: "12px"
  md: "14px"
  md-plus: "16px"
  card: "18px"
  lg: "20px"
  xl: "28px"
  xxl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "40px"
  button-primary-disabled:
    backgroundColor: "{colors.line}"
    textColor: "{colors.mute}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "40px"
  button-secondary-disabled:
    backgroundColor: "{colors.ground-2}"
    textColor: "{colors.mute}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "40px"
  button-quiet-hover:
    backgroundColor: "{colors.ground-2}"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.bad}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "40px"
  button-sm:
    rounded: "{rounded.sm}"
    padding: "4px 12px"
    height: "32px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
    height: "44px"
  pill-ok:
    backgroundColor: "{colors.ok-bg}"
    textColor: "{colors.ok}"
    typography: "{typography.micro}"
    rounded: "{rounded.full}"
    padding: "2px 10px"
  pill-bad:
    backgroundColor: "{colors.bad-bg}"
    textColor: "{colors.bad}"
    typography: "{typography.micro}"
    rounded: "{rounded.full}"
    padding: "2px 10px"
  pill-busy:
    backgroundColor: "{colors.warn-bg}"
    textColor: "{colors.warn}"
    typography: "{typography.micro}"
    rounded: "{rounded.full}"
    padding: "2px 10px"
  pill-idle:
    backgroundColor: "{colors.ground-2}"
    textColor: "{colors.mute}"
    typography: "{typography.micro}"
    rounded: "{rounded.full}"
    padding: "2px 10px"
  tag:
    backgroundColor: "{colors.ground-2}"
    textColor: "{colors.mute}"
    typography: "{typography.tag}"
    rounded: "{rounded.full}"
    padding: "0 8px"
  chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-2}"
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
    padding: "4px 12px"
  chip-selected:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-ink}"
  day-toggle:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    size: "40px"
  day-toggle-checked:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-ink}"
  tabs:
    backgroundColor: "{colors.rail-hover}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.segmented}"
    padding: "3px"
  tab-active:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "5px 14px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: "18px"
  notice-bad:
    backgroundColor: "{colors.bad-bg}"
    textColor: "{colors.bad-ink}"
    rounded: "{rounded.lg}"
    padding: "14px 16px"
  notice-warn:
    backgroundColor: "{colors.warn-bg}"
    textColor: "{colors.warn}"
    rounded: "{rounded.lg}"
    padding: "14px 16px"
  notice-ok:
    backgroundColor: "{colors.ok-bg}"
    textColor: "{colors.ok}"
    rounded: "{rounded.lg}"
    padding: "14px 16px"
  notice-info:
    backgroundColor: "{colors.ground-2}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.lg}"
    padding: "14px 16px"
  digest-bubble:
    backgroundColor: "{colors.bubble}"
    textColor: "{colors.ink}"
    typography: "{typography.bubble}"
    rounded: "{rounded.bubble}"
    padding: "20px 22px 12px"
    width: "680px"
  day-chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-2}"
    typography: "{typography.micro}"
    rounded: "{rounded.sm}"
    padding: "3px 10px"
  rail:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.ink}"
    padding: "16px 10px"
    width: "256px"
  rail-item:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.md}"
    padding: "7px 10px"
  rail-item-active:
    backgroundColor: "{colors.rail-active}"
    textColor: "{colors.ink}"
  avatar:
    backgroundColor: "{colors.avatar}"
    textColor: "{colors.avatar-ink}"
    rounded: "{rounded.full}"
    size: "32px"
  brand-mark:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground}"
    rounded: "{rounded.sm}"
    size: "26px"
  dialog:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sheet}"
    padding: "24px"
    width: "440px"
---

# Design System: msum

## Overview

**Creative North Star: "Your Own Chat"**

The web is a frame around one message. The digest is drawn the way it lands in the account's own chat: a flat soft-grey bubble on a white page, a day chip above it, the time and delivery ticks in its foot. Everything else (the light rail of accounts, the segmented tabs, the side column of actions and notices) exists to say whether that message is arriving, to fix it when it is not, and to tune what it says. The system refuses the grey card dashboard where the digest becomes one row of a table.

The material is Apple-style and monochrome: a white ground, a pale-grey rail and bubble (`#f5f5f7`), near-black ink (`#1d1d1f`), hairline cool-grey borders, and almost no shadow. The one accent is the ink itself: it fills the primary button, the active segmented tab, selected chips and weekday toggles, the checkbox, the current wizard step and the logo tile. Colour reports state only: green for connected or delivered, brick for problems, amber for busy or waiting, always with words beside it. Density is that of a settings app, not a cockpit: 15px body, generous row padding, one primary action per view.

The whole interface is one system sans, the face the user's own devices draw in, with tabular numerals wherever a time or a count appears. Nothing loads from the network: the font is the system one and every icon is inline SVG in a single stroke style. The brand is the lowercase "msum" wordmark beside a solid ink tile holding a speech bubble with an "m" in it (also the favicon). The web is light only for now.

**Key Characteristics:**
- The digest bubble is the one reader everywhere: summary, preview and history run.
- A light rail on the left holds the accounts, each with a 32px avatar initial and a status dot.
- White ground, `#f5f5f7` rail and bubble, 1px cool-grey hairlines; no shadow on content.
- Ink is the only accent; colour is reserved for state: green, brick, amber.
- One system sans, tabular numerals for times and counts.
- Controls share one vocabulary: 10px corners, 1px borders, 36 to 44px tall, one ink focus ring.

## Colors

A neutral grey world with ink as its single accent and three muted state hues.

### Primary
- **Ink Black** (`primary`, `ink`, `focus`): The one accent. Fills the primary button, selected chips, checked weekday toggles, the current wizard step, the logo tile, and the checkbox and radio accent. The same value is the text colour and the focus ring.
- **Primary Ink** (`primary-ink`): White text on any ink fill.

### Secondary (state)
- **Connected Green** (`ok`, `ok-bg`): Delivered and connected. The two delivery ticks of a sent digest, a connected pill, a checked switch track, a done wizard step, the progress bar, success notices.
- **Brick** (`bad`, `bad-bg`, `bad-ink`): Problems. Error pills and tags, the problem notice at the top of the side column, error text under fields, invalid input borders, destructive confirm buttons. `bad-ink` is the darker text on `bad-bg` so a notice stays readable.
- **Amber** (`warn`, `warn-bg`): Busy, reconnecting, waiting. The offline banner, warn notices, warn tags.

### Neutral
- **White Ground** (`ground`, `surface`): The page, panels, lists, tables, form sections, inputs, dialogs, the active tab.
- **Soft Grey** (`ground-2`, `rail`, `bubble`): `#f5f5f7`. The rail, the digest bubble, info notices, the privacy box, inline command chips, source tags, row hover in tables, the quiet button hover, the soft fill of disabled secondary buttons.
- **Rail Wash** (`rail-hover`, `rail-active`): Black at 4.5% and 7.5%. Rail item hover and current fill, and the track of the segmented tabs.
- **Hairline** (`line`): Every 1px border and divider between rows; the disabled primary button fill and the progress track.
- **Rule** (`line-strong`): The 1px border of controls (buttons, inputs, chips, weekday toggles), the unchecked switch track, the stepper connectors.
- **Ink steps** (`ink`, `ink-2`, `mute`): Text in three steps. `ink` for content and headings, `ink-2` for secondary text (bubble tasks and summary line, inactive tabs, rail links) and button hover borders, `mute` for metadata, hints, timestamps and placeholders.
- **Avatar Grey** (`avatar`, `avatar-ink`): The disc behind an account's initial.
- **Selection** (`sel`): Text selection highlight.

### Status dots
- **Rail dots** (`dot-ok`, `dot-bad`, `dot-busy`, `dot-idle`): The 12px dot on an account's avatar, with a 2px ring in the colour of whatever it sits on (`rail` in the rail, `surface` in the accounts list). Green, brick, amber, grey.

### Dark theme
Pending decision. The web declares `color-scheme: light` and ships no dark palette; the previous dark tokens were removed and are not recorded here. Do not add dark overrides until the decision is made.
### Named Rules
**The State Only Rule.** Green, brick and amber appear only when they report a state (delivered, connected, problem, busy). They never decorate, never fill a heading, never become a brand accent.

**The One Ink Rule.** Selection, the primary action, the active tab, the checkbox and the logo all use the same ink. A new selected state uses `primary` on `primary-ink`; it does not introduce a second accent.

## Typography

**Display Font:** System sans (`-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif`)
**Body Font:** The same system sans
**Label/Mono Font:** `ui-monospace, SF Mono, Menlo, Consolas, monospace`, for log messages and inline commands only

**Character:** One face, the one the user's devices already draw in, so the bubble reads as their own chat. Hierarchy comes from weight (400, 500, 600, 700) and a small set of sizes, not from a second family.

### Hierarchy
- **Display** (700, 1.75rem, 1.2, -0.02em): The page title, usually the account name beside its state pill. 1.5rem below 760px.
- **Headline** (700, 1.25rem, 1.2, -0.01em): Section and empty-state headings; also the time of a schedule row. Form section headings sit at 1.0625rem.
- **Stat** (700, 1.5rem, -0.01em, tabular): The one big figure in a side panel, such as the time of the next digest.
- **Brand** (650, 1.0625rem, -0.02em): The "msum" wordmark in the rail.
- **Title** (600, 0.9375rem): Names in lists, the title of a settings row, account names in the rail.
- **Body** (400, 15px, 1.5): Default text. Settings hints cap at 60ch, the privacy box at 72ch.
- **Bubble** (400, 15px, 1.55): Digest text. Section heads and the title line inside the bubble are 700.
- **Label** (600, 0.875rem): Field labels and legends; buttons use 0.875rem at 500, primary at 600.
- **Caption** (400, 0.8125rem): Hints, errors under fields, meta lines, chips, small buttons.
- **Micro** (600, 0.75rem): Pills, the day chip, table headers, the bubble foot.
- **Tag** (500, 0.6875rem): Source tags beside a setting's title.

### Named Rules
**The Tabular Time Rule.** Every time, count and number uses tabular numerals (`font-variant-numeric: tabular-nums`): bubble foot, schedule times, table cells, log timestamps, number and time inputs.

**The Weight Not Face Rule.** Hierarchy is weight and size inside one family. Monospace is for log messages and commands, nothing else.

## Layout

A three-part app frame. A 256px light rail on the left, sticky to the viewport with a 1px right hairline, holds the brand, Home, the account list and, pinned to the bottom, Add account and Logs. The main column centers a 1120px page with 28px of top padding and 20px between blocks. Inside an account, the work area is a split: a fluid column for the digest or the tab's content and a 320px side column (sticky at 20px from the top) for the problem notice, the next-digest panel and the actions, with a 28px gutter. The bubble caps at 680px; forms cap at 560px or 680px; the add-account wizard is a 760px column.

Spacing runs on a small, mostly even scale: 4, 6, 8 and 10px inside controls and clusters, 14px between stacked blocks and inside rows, 18 to 20px inside panels and form sections, 28px between columns, 48px at the page foot.

Responsive behavior has two steps. Below 1080px the split collapses to one column and the side column becomes an auto-fit grid of 240px cards. Below 760px the rail turns into a sticky top bar: the brand keeps its tile, accounts become a horizontal scroller of avatar-and-name items that fades out at the right edge, the rail labels, wordmark and status lines hide, and Add account and Logs move to icon buttons at the end. The segmented tabs scroll horizontally with the same fade. Settings rows, log rows and the QR layout stack. Page gutters respect safe-area insets everywhere.

### Named Rules
**The Problems First Rule.** In the side column, a problem notice sits above the next-digest panel and the actions. On the accounts home, accounts with problems come first.

## Elevation & Depth

Flat. Panels, lists, tables, form sections and the digest bubble sit on the white ground separated by tone (`#f5f5f7` against white) and 1px hairlines; the bubble has no shadow at all. Depth appears in three places only: the confirmation dialog, which is the only thing that floats, over a dimmed backdrop; the active segmented tab, which lifts a hair off its grey track; and the switch knob.

### Shadow Vocabulary
- **Dialog lift** (`box-shadow: 0 20px 60px -20px rgb(0 0 0 / 0.4)`, backdrop `rgb(21 27 33 / 0.45)`): The confirm dialog.
- **Active tab** (`box-shadow: 0 1px 3px rgba(0, 0, 0, 0.14)`): The current segment of the tabs.
- **Knob** (`box-shadow: 0 1px 2px rgb(0 0 0 / 0.25)`): The white knob of the switch.
- **Focus halo** (`box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus) 12%, transparent)`): Focused inputs, selects and textareas, together with an ink border.

## Shapes

Soft corners that grow with the size of the container: 6px on inline code, skeleton lines and the focus ring fallback, 8px on small buttons, the day chip, the active tab and the logo tile, 10px on buttons, inputs, rail items and weekday toggles, 11px on the segmented track, 12px on notices, choice cards, the privacy box and the QR, 14px on panels, lists, tables, form sections and log lists, 16px on the bubble, dialogs and the centered card. Pills, tags, chips, the switch and the progress bar are fully round; avatars and status dots are circles.

The bubble is a plain rounded rectangle: 16px on all four corners, no tail, no asymmetry. A continuation bubble (the second part of a split digest) looks the same.

Borders are 1px everywhere, for containers, dividers and controls alike; choice cards in the wizard use 1.5px. The next-runs list uses a dashed 1px divider.

## Components

### Buttons
Calm and solid; one primary per view.
- **Shape:** gently rounded (10px), 40px tall, 8px 16px padding, 0.875rem at weight 500, 1px border.
- **Primary:** ink fill with white text at weight 600. Hover mixes 12% of the ground into the fill.
- **Secondary (default):** white surface with a 1px `line-strong` border and ink text. Hover darkens the border to `ink-2`.
- **Quiet:** transparent with no visible border; hover shows the soft-grey fill and a hairline border.
- **Danger:** a secondary button with brick text. In confirm dialogs, the destructive action is a solid brick button with white text.
- **Small:** 32px tall, 4px 12px padding, 8px corners, 0.8125rem.
- **States:** pressing moves the button down 1px; disabled is a soft grey fill (`ground-2` with a hairline border and `mute` text, or the hairline colour with `mute` text for primary), with a not-allowed cursor; focus is the shared 2px ink ring. Transitions are 0.15s ease-out on background and border.
- **Link-like button:** plain underlined `ink-2` text at 0.875rem for secondary actions inside text.

### Pills
- **Style:** fully round, tinted fill (the state colour at 12%), no border, micro type (0.75rem, 600). The colour is the state: `ok`, `bad`, `warn`, or `mute` for idle. Sits beside the page title and in account rows.

### Tags
- **Style:** fully round, 0.6875rem at 500, soft-grey fill with a hairline border and `mute` text. Sits beside a setting's title to say where its value comes from. The `warn` and `bad` variants tint the fill and drop the border.

### Chips
- **Style:** fully round, 1px `line-strong` border, white fill, `ink-2` text at 0.8125rem.
- **State:** pressed chips fill with ink and white text. Used as filters (log levels) and as the template picker for prompts.

### Weekday toggles
Square 40px boxes with 10px corners and 1px borders, bold 0.875rem letter. Checked days fill with ink. The real checkbox sits invisibly on top, so keyboard focus draws the ink ring on the box.

### Switch
A 40 by 24px round track in `line-strong` with an 18px white knob; checked turns the track green and slides the knob 16px with a 0.18s spring curve. Used for per-conversation and settings toggles. Native checkboxes and radios take the ink accent.

### Cards / Containers
- **Panel:** white surface, 1px hairline, 14px corners, 18px padding, 10px internal gap. Holds the next-digest figure and side actions.
- **List:** the same frame with rows divided by hairlines; rows pad 12 to 14px vertically and 18px horizontally. The log list follows it: one entry per row, time and level tag and account on the meta line, the message in mono below.
- **Form section:** the same frame with 20px padding; settings rows inside it are a two-column grid (text left, control right, 40px gutter) divided by hairlines.
- **Notices:** 12px corners, 14px 16px padding, no border, tinted fill by state (`bad-bg` with `bad-ink`, `warn-bg`, `ok-bg`, or soft grey with a hairline for info). A notice can carry a fix action aligned to its right.
- **Shadow strategy:** none (see Elevation & Depth).

### Inputs / Fields
- **Style:** white fill, 1px `line-strong` border, 10px corners, 44px tall, 10px 14px padding, 0.9375rem. Selects carry an inline chevron drawn in `mute`. Textareas are at least 280px tall with 1.55 line height.
- **Hover:** border darkens to `mute`.
- **Focus:** border turns ink with a soft 3px halo at 12%.
- **Error / Disabled:** invalid fields take a brick border with a brick caption below; disabled is 60% opacity.
- **Field anatomy:** label (0.875rem, 600) above, control, then a muted caption hint. A unit suffix can sit inside the right edge of a number input.
- **Model picker and language switch:** built from the same select and chip vocabulary, with no custom chrome.

### Navigation
- **Rail:** `#f5f5f7`, 256px, 16px 10px padding, 1px right hairline. Items are 10px-cornered rows; hover is a 4.5% black wash, the current page a 7.5% wash with ink text. Account items show a 32px avatar disc with the initial and a status dot, the name in 0.9375rem, and a muted next-run line in 0.75rem that turns brick on a problem. The brand is a 26px solid ink tile (8px corners) holding the bubble-with-m mark in white and ink, beside the "msum" wordmark.
- **Tabs:** a segmented control. A 3px-padded track in the 4.5% wash, 11px corners, fit to content; segments are 5px 14px, 8px corners, `ink-2` text. The current segment turns white with ink text at 600 and a soft shadow.
- **Breadcrumb:** muted 0.875rem with a back chevron, used on run detail, preview and link pages.
- **Mobile:** see Layout; the rail becomes a top bar of avatar items.

### Wizard stepper
The add-account flow has three steps. A row of 24px numbered circles with 1px outlines joined by 20px rules. The current step fills ink, done steps take the green tint with a check, the rest stay outlined.

### Digest Bubble (signature)
The one reader for every digest: the overview's last digest, the preview, and each run in the history. A centered day chip (Today, Yesterday, a date) sits above the first bubble. The bubble is `#f5f5f7` on white, max 680px, 20px 22px 12px padding, 16px on every corner, no tail and no shadow. Inside, the first block is a bold title line and an `ink-2` summary line; each following block is a section with a bold head (an opening emoji gets its own gap), bulleted items, and indented `ink-2` tasks. The foot is right-aligned micro text: the time in tabular numerals, an optional state word, and the ticks.

Ticks tell the delivery story and change as a run progresses: a clock while pending or for a draft, one grey tick when queued or read back from history, two green ticks when the daemon confirms delivery in this session (the colour eases in over 0.25s). A just-delivered bubble arrives with a 10px rise and fade over 0.32s. A draft bubble mixes 30% of the ground into its fill. While a digest is being made, the bubble shows three skeleton lines. A digest longer than one message becomes several bubbles.

Digest text comes from third parties: it is parsed into lines and bold spans and always rendered as text, never as markup.

## Do's and Don'ts

### Do:
- **Do** show any digest through the bubble component, with its day chip, time and ticks, wherever a digest appears.
- **Do** use `primary` on `primary-ink` for every selected or current state and for the single primary button of a view.
- **Do** reserve `ok`, `bad` and `warn` for state, each paired with words or an icon so colour is never the only signal.
- **Do** keep controls at 10px corners, 1px `line-strong` borders, 40px (buttons) or 44px (inputs) tall.
- **Do** separate containers with 1px `line` hairlines on white surfaces, or with the `#f5f5f7` tone; keep them flat.
- **Do** use tabular numerals for every time and count.
- **Do** draw icons as inline 24px-viewbox SVG with a 1.8 stroke, round caps and joins, `currentColor`, no fill.
- **Do** give every interactive element the shared focus ring (2px ink, 2px offset) and honor reduced motion, which removes every transition and animation.
- **Do** put the problem notice first in the side column, with its fix action inside the notice.

### Don't:
- **Don't** turn the digest into a row of a table or a grey dashboard card; it is a message in a chat.
- **Don't** load fonts, icon sets or anything else from the network.
- **Don't** add shadows to panels, lists, form sections or the bubble; only the dialog floats.
- **Don't** introduce a second accent colour for selection or emphasis.
- **Don't** add a dark palette piecemeal; the dark theme is a pending decision for the whole system.
- **Don't** render digest text as HTML; it is written by third parties.
- **Don't** use modals except for short confirmations; flows are pages.
