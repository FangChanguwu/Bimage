# Bimage interface system

A restrained tool for sustained image work. Users sit at a desktop under normal ambient light, so the default is a cool, light canvas with clean white work surfaces; a coordinated dark theme supports late sessions. Artwork, not interface chrome, supplies saturation.

## Composition
A floating narrow sidebar and two equal desktop columns: prompt/controls on the left, task history on the right. At intermediate widths the sidebar becomes an icon rail; below 850px the workspace stacks; below 560px navigation becomes a compact top row. No desktop layout is squeezed onto a phone. Screens at 320px remain fully usable.

## Tokens (frontend/src/style.css)
| Role | Light | Dark |
|---|---|---|
| canvas | #f6f6f9 | #17171d |
| surface | #ffffff | #222229 |
| input | #f8f8fb | #292931 |
| ink | #242332 | #efedf5 |
| muted | #686776 | #b5b2c3 |
| line | #e6e5ed | #39373f |
| accent | #7451c8 | #b295f1 |
| accent soft | #f0eafa | #362c49 |

System sans stack with native Chinese fallbacks. Headings 26/16/14px, routine controls 13px, form labels 12px, compact metadata 10–11px. Main corners 16px, controls 9px. Section gaps 24px, control gaps 8px; panels have fine borders and a soft downward shadow. Icons are consistently Lucide line icons.

## Interaction rules
- A single purple generation action. Clear and quick-prompt tools are labelled icon buttons.
- Clear affects prompt and references only; successful submission clears only the unchanged submitted draft.
- Auto-size explains why ratio and resolution are disabled. Manual size estimates are not actual result dimensions.
- Job summaries collapse whitespace to two lines; complete prompt details preserve original multiline text.
- Preview has zoom, pan, pinch, reset, original download and copy. Clipboard success is announced only after actual write resolves.
- Retry and repair say they refill a draft and do not generate. Repair annotates original pixel resolution, preserving pointer scaling independently of DPR.
- Native dialog top-layer behavior provides focus containment and Escape. Focus returns to the opener. All icon-only navigation keeps accessible names at compact widths.
- Branding preview is a separate 80×80 square alongside custom upload controls, near the field label. Save is a distinct footer action. Native file controls are hidden, reachable via a keyboard button.

## Evidence and scope
Chromium fixtures cover desktop, 390px and 320px in both themes. The [desktop preview](docs/preview.png) uses demonstration data and does not represent production accounts or paid-model output.
