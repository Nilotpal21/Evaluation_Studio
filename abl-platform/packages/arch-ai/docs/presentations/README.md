# Arch AI · Presentations

Five entry points for five audiences. Open any `.html` file directly in a browser — they are self-contained, no build step.

| File                                       | Audience                                              | Format                              | What's inside                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------ | ----------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`slides.html`](./slides.html)             | **Live presentation** — board, all-hands, sales pitch | Slide deck (15 slides, scroll-snap) | Title → Problem → Three Acts (Now/Next/Future) → Five Engines → 11 Specialists with tier badges → Phase timeline (live vs planned) → Six gates → ABL language showcase with code → Knowledge layer → What's built today → Six in-project conversation examples → Page-aware specialist routing → Stats → Roadmap → Closing pillars. Right-rail nav dots, keyboard navigation (arrows/space/Home/End/T), light + dark theme. |
| [`showcase.html`](./showcase.html)         | **Non-technical** — execs, customers, sales, partners | Visual scroll page                  | Animated hero, "tangled wires" problem illustration, three-step "talk → design → ship" walkthrough, live blueprint demo (chat + topology builds itself), team characters, six use-case cards, before/after comparison slider, outcome metrics. Light + dark theme.                                                                                                                                                          |
| [`presentation.html`](./presentation.html) | Mixed audience · short demo                           | Marketing scroll deck               | Hero, problem, animated chat walkthrough, four phase strip, specialist grid, six artifacts, eight stat tiles, CTA. Auto-plays the chat demo on scroll.                                                                                                                                                                                                                                                                      |
| [`deep-dive.html`](./deep-dive.html)       | Mixed audience · long-form                            | Interactive guide                   | Production-grade walkthrough with sticky sidebar nav. Full breakdown of 4 phases, 11+ specialists (click to expand), 6 gates, 35+ knowledge cards (filterable), tools/execution, streaming protocol, persistence, **10 step-by-step scenarios** (interactive sliders), 10-question FAQ. Light + dark theme.                                                                                                                 |
| [`architecture.html`](./architecture.html) | Engineers                                             | Subsystem diagram                   | Interactive map with three layers (Surface → arch-ai → Persistence), color-coded nodes, click-to-highlight related edges, info panel per subsystem, phase lifecycle strip with the legal `BUILD → BLUEPRINT` backtrack.                                                                                                                                                                                                     |

For the underlying reference, see [`../DESIGN.md`](../DESIGN.md).

## Audience routing cheat sheet

- **Live presenting on a screen** → `slides.html` (use arrows / space to advance, T to toggle theme)
- **5-minute pitch landing page** → `showcase.html`
- **Demo on a laptop in front of a customer** → `showcase.html` then `presentation.html`
- **Hand to a stakeholder for self-serve reading** → `deep-dive.html`
- **Engineering review / onboarding a new dev** → `architecture.html` + `../DESIGN.md`

## Keyboard shortcuts (slides.html)

| Key                        | Action             |
| -------------------------- | ------------------ |
| `→` `↓` `Space` `PageDown` | Next slide         |
| `←` `↑` `PageUp`           | Previous slide     |
| `Home` / `End`             | First / last slide |
| `T`                        | Toggle theme       |

All five files share a common visual language and cross-link to each other in the footer / nav.
