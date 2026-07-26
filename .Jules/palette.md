## 2026-07-26 - Adding aria-label to icon-only buttons
**Learning:** Found several icon-only buttons (especially in toolbars, dialogs and modals like graph3d, schema browser, etc) using just `title` which can be insufficient for screen readers. Added `aria-label` alongside `title` where an icon is used instead of text.
**Action:** Always include `aria-label` for buttons relying solely on icons (e.g. ✕, ⟳, etc) to ensure full accessibility.
