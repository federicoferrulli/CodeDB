## 2024-05-19 - Accessible Names for Inputs and Icon-Only Buttons
**Learning:** While `title` tooltips and `placeholder` text provide some context for visual users, screen readers strictly require `aria-label` (or `<label>`) attributes for standalone input fields and icon-only buttons to ensure they have an accessible name. Without explicit labels, they remain largely inaccessible or confusing.
**Action:** When adding search bars, standalone inputs, or icon-only buttons anywhere in the interface, always supply a descriptive `aria-label` alongside any `placeholder` or `title` attributes.
