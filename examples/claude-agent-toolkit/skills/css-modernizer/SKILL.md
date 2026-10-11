---
name: css-modernizer
description: Audit a CSS file for syntax that cssnext transpiles and report which features are used, which are safe to ship as-is, and which need a fallback. Use whenever a stylesheet is reviewed, modernised, or checked before a release.
---

# CSS modernizer

Audit a stylesheet against the feature set cssnext transpiles, then report on it.

## Steps

1. Run the auditor over every stylesheet in scope:

   ```bash
   python css-modernizer/audit.py path/to/styles.css
   ```

   It prints one JSON object with a `features` array. Each entry has the
   feature name, the line it was found on, and the matched text.

2. Group the findings by feature and write a short report that answers three
   questions for each one:

   - What is the modern syntax being used?
   - What does cssnext compile it down to?
   - Does anything still need a hand-written fallback?

3. Flag anything the auditor could not classify rather than guessing. A
   stylesheet with no findings is a valid result: say so plainly instead of
   inventing work.

## Reporting

Keep the report to the features actually found. Order them by count, most
frequent first. Do not recommend rewriting code that already compiles cleanly.
