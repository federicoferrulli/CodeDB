## 2026-07-28 - Add aria-labels to icon-only buttons
**Learning:** Missing aria-labels on icon-only buttons represents an accessibility issue pattern across this app's UI elements, specifically those providing auxiliary functions like closing panels or reloading schemas. These labels must be provided to assist users relying on screen readers.
**Action:** Always verify that every `<button>` without descriptive text content includes an `aria-label` during component audits or implementation.
