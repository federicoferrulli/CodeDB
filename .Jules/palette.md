## 2026-07-29 - Missing ARIA Labels on Search Inputs and Icon Buttons
**Learning:** The application lacked ARIA labels for standalone search inputs relying only on placeholders, which are insufficient for screen readers. Additionally, several icon-only buttons lacked aria-labels.
**Action:** Always ensure search inputs without visible labels and icon-only buttons include an `aria-label` attribute for screen readers.
