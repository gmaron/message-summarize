---
name: message-summarize
description: A local control panel that frames the digest exactly as it lands in your own chat.
colors:
  primary: "#22313f"
  primary-ink: "#ffffff"
  slate: "#22313f"
  slate-2: "#2c3e50"
  slate-ink: "#dce4ec"
  slate-mute: "#a9b6c3"
  avatar: "#4b6378"
  ground: "#f4f2ee"
  ground-2: "#faf9f6"
  surface: "#ffffff"
  bubble: "#ffffff"
  line: "#e1ddd5"
  line-strong: "#cfc9be"
  ink: "#1d2328"
  ink-2: "#4f5a63"
  mute: "#66707a"
  ok: "#2f6b5b"
  ok-bg: "#e3f0ea"
  bad: "#a8432f"
  bad-bg: "#fbe9e4"
  bad-ink: "#7a2c1c"
  warn: "#8a5a00"
  warn-bg: "#fbf0d9"
  focus: "#2e6fa8"
  sel: "#cfe0ee"
  dot-ok: "#6fbf9e"
  dot-bad: "#f0957f"
  dot-busy: "#e9c077"
  dot-idle: "#a9b6c3"
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
  mono:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
rounded:
  tail: "4px"
  xs: "6px"
  sm: "8px"
  md: "10px"
  lg: "12px"
  xl: "14px"
  sheet: "16px"
  bubble: "18px"
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
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "40px"
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
  pill:
    backgroundColor: "transparent"
    typography: "{typography.micro}"
    rounded: "{rounded.full}"
    padding: "2px 10px"
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
    backgroundColor: "{colors.slate}"
    textColor: "{colors.slate-ink}"
    padding: "20px 12px"
    width: "256px"
  rail-item:
    textColor: "{colors.slate-ink}"
    rounded: "{rounded.md}"
    padding: "9px 10px"
  rail-item-active:
    backgroundColor: "{colors.slate-2}"
  avatar:
    backgroundColor: "{colors.avatar}"
    textColor: "#ffffff"
    rounded: "{rounded.full}"
    size: "36px"
  dialog:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sheet}"
    padding: "24px"
    width: "440px"
---

# Design System: message-summarize

## Overview

**Creative North Star: "Your Own Chat"**

The web is a frame around one message. The digest is drawn exactly as it lands in the account's own chat: a white bubble with a squared top-left corner and a small tail, a day chip above it, the time and delivery ticks in its foot. Everything else on the page (the slate rail of accounts, the tabs, the side column of actions and notices) exists to say whether that message is arriving, to fix it when it is not, and to tune what it says. The system refuses the grey card dashboard where the digest becomes one row of a table.

The material is warm and quiet: a stone-paper ground, hairline warm-grey borders, white surfaces, and one cool slate that does all the structural work (the rail, the primary button, every selected state). Color carries state only. Sea-green means delivered or connected, brick means a problem, ochre means busy or waiting. Density is that of a settings app, not a cockpit: 15px body, generous row padding, one primary action per view.

The whole interface is one system sans, the same face the user's chat client draws in, with tabular numerals wherever a time or a count appears. Nothing loads from the network: the font is the system one and every icon is inline SVG drawn in a single stroke style. Light and dark follow the operating system.

**Key Characteristics:**
- The digest bubble is the one reader everywhere: summary, preview and history run.
- A slate rail on the left holds the accounts, each with an avatar initial and a status dot.
- Warm stone ground and white surfaces separated by 1px warm-grey hairlines; almost no shadow.
- Color is reserved for state: sea-green, brick, ochre, and slate for selection.
- One system sans, tabular numerals for times and counts.
- Controls share one vocabulary: 10px corners, 1.5px borders, 40 to 44px tall.

## Colors

A warm neutral paper world with one cool slate for structure and three muted state hues.

### Primary
- **Slate Ink Navy** (`slate`, `primary`): The structural color. Fills the account rail, the primary button, and every selected control (chips, weekday toggles, the current wizard step, the chosen radio card border, the active tab underline). In dark mode `primary` flips to the pale `slate-ink` so the selected states stay the brightest thing on the page.
- **Rail Hover Slate** (`slate-2`): The active and hover fill of rail items, and the rail's scrollbar thumb.
- **Rail Text** (`slate-ink`, `slate-mute`): Primary and secondary text on the rail. `slate-mute` also carries the rail's group label and each account's next-run line.
- **Avatar Slate** (`avatar`): The disc behind an account's initial, with white text.

### Secondary (state)
- **Sea Green** (`ok`, `ok-bg`): Delivered and connected. The two delivery ticks of a sent digest, a connected pill, a checked switch, a done wizard step, the progress bar, success notices.
- **Brick** (`bad`, `bad-bg`, `bad-ink`): Problems. Error pills, the problem notice at the top of the side column, error text under fields, invalid input borders, destructive confirm buttons. `bad-ink` is the darker text used on `bad-bg` so a notice stays readable.
- **Ochre** (`warn`, `warn-bg`): Busy, reconnecting, waiting. The offline banner, warn notices, warn log levels.

### Tertiary
- **Focus Blue** (`focus`): Focus rings only. A 2px outline at 2px offset on everything; inputs instead turn their border blue and add a 3px halo at 25% strength.
- **Selection Blue** (`sel`): Text selection highlight.

### Neutral
- **Stone Ground** (`ground`): The page background behind the work column; also the sticky save bar.
- **Paper** (`ground-2`): A step lighter than the ground. Info notices, the privacy box, inline command chips, row hover in tables, the quiet button's hover.
- **White Surface** (`surface`, `bubble`): Panels, lists, tables, form sections, inputs, dialogs, and the digest bubble. `bubble` is its own token because in dark mode the bubble sits one step above the surface.
- **Warm Hairline** (`line`): Every 1px border and divider between rows.
- **Warm Rule** (`line-strong`): The 1.5px border of controls (buttons, inputs, chips, weekday toggles), the unchecked switch track, the stepper connectors.
- **Ink** (`ink`, `ink-2`, `mute`): Text in three steps. `ink` for content and headings, `ink-2` for secondary text inside the bubble (tasks, the summary line) and hover borders, `mute` for metadata, hints, timestamps and inactive tabs.

### Status dots
- **Rail dots** (`dot-ok`, `dot-bad`, `dot-busy`, `dot-idle`): The 12px dot on an account's avatar. These are lighter, theme-independent hues because the rail is dark in both themes; the dot carries a 2px ring in the color of whatever it sits on (`slate` in the rail, `surface` in the accounts list).

### Dark theme
Defined in `src/interfaces/web/app.css` under `prefers-color-scheme: dark`. The ground becomes a warm umber (`#1a1816`), surfaces step up in warm browns, the rail darkens to near-black slate (`#0f151b`), the state hues lighten to pastel foreground colors on deep tinted backgrounds, and `primary` / `primary-ink` swap to pale slate on dark ink. Every token above has a dark counterpart; nothing is added or removed.

### Named Rules
**The State Only Rule.** Sea-green, brick and ochre appear only when they report a state (delivered, connected, problem, busy). They never decorate, never fill a heading, never become a brand accent.

**The One Slate Rule.** Selection, the primary action and the rail all use the same slate. A new selected state uses `primary` on `primary-ink`; it does not introduce a second accent.

## Typography

**Display Font:** System sans (`-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif`)
**Body Font:** The same system sans
**Label/Mono Font:** `ui-monospace, SF Mono, Menlo, Consolas, monospace`, for log lines and inline commands only

**Character:** One face, the one the user's chat client already draws in, so the bubble reads as their own chat. Hierarchy comes from weight (400, 500, 600, 700) and a small set of sizes, not from a second family.

### Hierarchy
- **Display** (700, 1.75rem, 1.2, -0.02em): The page title, usually the account name beside its state pill. 1.5rem below 760px.
- **Headline** (700, 1.25rem, 1.2, -0.01em): Section and empty-state headings; also the time of a schedule row.
- **Stat** (700, 1.5rem, -0.01em, tabular): The one big figure in a side panel, such as the time of the next digest.
- **Title** (600, 0.9375rem): Names in lists, the title of a settings row, account names in the rail. Form section headings sit at 1.0625rem.
- **Body** (400, 15px, 1.5): Default text. Settings hints cap at 60ch, the privacy box at 72ch.
- **Bubble** (400, 15px, 1.55): Digest text. Section heads and the title line inside the bubble are 700.
- **Label** (600, 0.875rem): Field labels, legends, buttons (buttons are 500, primary 600).
- **Caption** (400, 0.8125rem): Hints, errors under fields, meta lines, chips, small buttons.
- **Micro** (600, 0.75rem): Pills, the day chip, table headers, the bubble foot.

### Named Rules
**The Tabular Time Rule.** Every time, count and number uses tabular numerals (`font-variant-numeric: tabular-nums`): bubble foot, schedule times, table cells, number and time inputs.

**The Weight Not Face Rule.** Hierarchy is weight and size inside one family. Monospace is for log lines and commands, nothing else.

## Layout

A three-part app frame. A fixed 256px slate rail on the left, sticky to the viewport, holds the brand, Home, the account list and, pinned to the bottom, Add account and Logs. The main column centers a 1120px page with 28px of top padding and 20px between blocks. Inside an account, the work area is a split: a fluid column for the digest or the tab's content and a 320px side column (sticky at 20px from the top) for the problem notice, the next-digest panel and the actions, with a 28px gutter. The bubble caps at 680px; forms cap at 560px or 680px.

Spacing runs on a small, mostly even scale: 4, 6, 8 and 10px inside controls and clusters, 14px between stacked blocks and inside rows, 18 to 20px inside panels and form sections, 28px between columns, 48px at the page foot.

Responsive behavior has two steps. Below 1080px the split collapses to one column and the side column becomes an auto-fit grid of 240px cards. Below 760px the rail turns into a sticky top bar: the brand keeps its icon, accounts become a horizontal scroller of avatar-and-name chips that fades out at the right edge, the rail labels and status lines hide, and Add account and Logs move to icon buttons at the end. Tabs scroll horizontally with the same fade. Settings rows and the QR layout stack. Page gutters respect safe-area insets everywhere.

### Named Rules
**The Problems First Rule.** In the side column, a problem notice sits above the next-digest panel and the actions. On the accounts home, accounts with problems come first.

## Elevation & Depth

Flat by default, separated by tone and hairlines. Panels, lists, tables and form sections sit on the stone ground as white surfaces with a 1px `line` border and no shadow. Depth appears in three places only: the digest bubble, which floats slightly like a message in a chat; the confirmation dialog, which lifts over a dimmed backdrop; and the switch knob.

### Shadow Vocabulary
- **Bubble lift** (`box-shadow: 0 1px 2px var(--bubble-shadow), 0 6px 18px -8px var(--bubble-shadow)`): The digest bubble only. `--bubble-shadow` is slate at 8% in light, black at 35% in dark.
- **Dialog lift** (`box-shadow: 0 20px 60px -20px rgb(0 0 0 / 0.4)`, backdrop `rgb(21 27 33 / 0.45)`): The confirm dialog.
- **Knob** (`box-shadow: 0 1px 2px rgb(0 0 0 / 0.25)`): The white knob of the switch.
- **Focus halo** (`box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus) 25%, transparent)`): Focused inputs, selects and textareas.

### Named Rules
**The One Floating Thing Rule.** The bubble is the only content that casts a shadow. Panels and cards beside it stay flat, so the message is what the eye lands on.

## Shapes

Soft, friendly corners that grow with the size of the container: 6px on inline code and skeleton lines, 8px on small buttons and the day chip, 10px on buttons, inputs, rail items and weekday toggles, 12px on notices, the privacy box and the QR, 14px on panels, lists, tables and form sections, 16px on dialogs and the centered card. Pills, chips, the switch and the progress bar are fully round; avatars and status dots are circles.

The bubble is the one asymmetric shape: 18px on three corners and 4px on the top-left, with a small triangular tail clipped out of its top-left edge. A continuation bubble (the second part of a split digest) is round on all corners and has no tail.

Borders are 1px for containers and dividers, 1.5px for controls and pills. The next-runs list uses a dashed 1px divider.

## Components

### Buttons
Calm and solid; one primary per view.
- **Shape:** gently rounded (10px), 40px tall, 8px 16px padding, 0.875rem at weight 500.
- **Primary:** slate fill with white text at weight 600. Hover mixes 12% of the ground into the fill.
- **Secondary (default):** white surface with a 1.5px `line-strong` border and ink text. Hover darkens the border to `ink-2`.
- **Quiet:** transparent with no visible border; hover shows the paper fill and a hairline border.
- **Danger:** a secondary button with brick text. In confirm dialogs, the destructive action is a solid brick button.
- **Small:** 32px tall, 4px 12px padding, 8px corners, 0.8125rem.
- **States:** pressing moves the button down 1px; disabled is 50% opacity with a not-allowed cursor; focus is the shared 2px blue ring. Transitions are 0.15s ease-out on background and border.
- **Link-like button:** plain underlined `ink-2` text at 0.875rem for secondary actions inside text ("Cambiar horarios", "Ver historial").

### Pills
- **Style:** fully round, 1.5px border in `currentColor`, transparent fill, micro type (0.75rem, 600). The color is the state: `ok`, `bad`, `warn`, or `mute` for idle. Sits beside the page title and in account rows.

### Chips
- **Style:** fully round, 1.5px `line-strong` border, white fill, `ink-2` text at 0.8125rem.
- **State:** pressed chips fill with slate and white text (pale slate and dark ink in dark mode). Used as filters, for example log levels.

### Weekday toggles
Square 40px boxes with 10px corners and 1.5px borders, bold 0.875rem letter. Checked days fill with slate. The real checkbox sits invisibly on top, so keyboard focus draws the blue ring on the box.

### Switch
A 40 by 24px round track in `line-strong` with an 18px white knob; checked turns the track sea-green and slides the knob 16px with a 0.18s spring curve. Used for per-conversation and settings toggles.

### Cards / Containers
- **Panel:** white surface, 1px hairline, 14px corners, 18px padding, 10px internal gap. Holds the next-digest figure and side actions.
- **List:** the same frame with rows divided by hairlines; rows pad 12 to 14px vertically and 18px horizontally.
- **Form section:** the same frame with 20px padding; settings rows inside it are a two-column grid (text left, control right, 40px gutter) divided by hairlines.
- **Notices:** 12px corners, 14px 16px padding, no border, tinted fill by state (`bad-bg` with `bad-ink`, `warn-bg`, `ok-bg`, or paper with a hairline for info). A notice can carry a fix action aligned to its right.
- **Shadow strategy:** none (see Elevation & Depth).

### Inputs / Fields
- **Style:** white fill, 1.5px `line-strong` border, 10px corners, 44px tall, 10px 14px padding, 0.9375rem. Selects carry an inline chevron drawn in `mute`. Textareas are at least 280px tall with 1.55 line height.
- **Hover:** border darkens to `ink-2`.
- **Focus:** border turns `focus` blue with a 3px halo at 25%.
- **Error / Disabled:** invalid fields take a brick border with a brick caption below; disabled is 60% opacity.
- **Field anatomy:** label (0.875rem, 600) above, control, then a muted caption hint. A unit suffix can sit inside the right edge of a number input.

### Navigation
- **Rail:** slate, 256px, 20px 12px padding. Items are 10px-cornered rows with 9px 10px padding; hover fills `slate-2` at 70%, the current page fills `slate-2`. Account items show a 36px avatar disc with the initial and a status dot, the name in 0.9375rem, and a muted next-run line in 0.75rem that turns light brick on a problem.
- **Tabs:** text tabs 22px apart over a hairline; inactive in `mute`, current in `ink` at 600 with a 3px slate underline (pale slate in dark mode).
- **Breadcrumb:** muted 0.875rem with a back chevron, used on run detail, preview and link pages.
- **Mobile:** see Layout; the rail becomes a top bar of avatar chips.

### Wizard stepper
A row of 24px numbered circles joined by 20px rules. The current step fills slate, done steps take the sea-green tint with a check, the rest stay outlined.

### Digest Bubble (signature)
The one reader for every digest: the overview's last digest, the preview, and each run in the history. A centered day chip (Today, Yesterday, a date) sits above the first bubble. The bubble is white, max 680px, 20px 22px 12px padding, with the 4px top-left corner and tail, and the bubble lift shadow. Inside, the first block is a bold title line and an `ink-2` summary line; each following block is a section with a bold head (an opening emoji gets its own gap), bulleted items, and indented `ink-2` tasks. The foot is right-aligned micro text: the time in tabular numerals, an optional state word, and the ticks.

Ticks tell the delivery story and change as a run progresses: a clock while pending or for a draft, one grey tick when queued or read back from history, two sea-green ticks when the daemon confirms delivery in this session (the color eases in over 0.25s). A just-delivered bubble arrives with a 10px rise and fade over 0.32s. A draft bubble mixes 30% of the ground into its fill. While a digest is being made, the bubble shows three skeleton lines. A digest longer than one message becomes several bubbles; only the first has the tail.

Digest text comes from third parties: it is parsed into lines and bold spans and always rendered as text, never as markup.

## Do's and Don'ts

### Do:
- **Do** show any digest through the bubble component, with its day chip, time and ticks, wherever a digest appears.
- **Do** use `primary` on `primary-ink` for every selected or current state and for the single primary button of a view.
- **Do** reserve `ok`, `bad` and `warn` for state, each paired with words or an icon so color is never the only signal.
- **Do** keep controls at 10px corners, 1.5px `line-strong` borders, 40px (buttons) or 44px (inputs) tall.
- **Do** separate containers with 1px `line` hairlines on white surfaces; keep them flat.
- **Do** use tabular numerals for every time and count.
- **Do** draw icons as inline 24px-viewbox SVG with a 1.8 stroke, round caps and joins, `currentColor`, no fill.
- **Do** give every interactive element the shared focus ring (2px `focus`, 2px offset) and honor reduced motion, which removes every transition and animation.
- **Do** put the problem notice first in the side column, with its fix action inside the notice.

### Don't:
- **Don't** turn the digest into a row of a table or a grey dashboard card; it is a message in a chat.
- **Don't** load fonts, icon sets or anything else from the network.
- **Don't** add shadows to panels, lists or form sections; the bubble is the only floating content.
- **Don't** introduce a second accent color for selection or emphasis.
- **Don't** render digest text as HTML; it is written by third parties.
- **Don't** use modals except for short confirmations; flows are pages.
