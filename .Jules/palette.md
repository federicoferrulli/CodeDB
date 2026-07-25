## 2026-07-25 - Placeholder Attributes as Accessible Names
**Learning:** Placeholder text is often insufficient as an accessible name for screen readers. Inputs (especially search fields) and icon-only buttons need an explicit `aria-label` attribute if no visible `<label>` is associated.
**Action:** Always add `aria-label` to standalone inputs and icon-only buttons during UX audits.