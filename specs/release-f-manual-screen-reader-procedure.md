# Release F manual screen-reader acceptance procedure

Procedure ID: `release-f-manual-screen-reader`
Procedure version: `1`
Status: procedure only. Completing this document is not evidence.

A real bounded NVDA or VoiceOver run must be performed against the exact immutable Release F build. The external JSON record and UTF-8 transcript must pass `ManualScreenReaderEvidenceV1` and the Release F ingestion verifier.

## Supported environments

Use exactly one supported combination:

- NVDA on Windows 10 or Windows 11
- VoiceOver on macOS

Record:

- exact Clay Git commit and tree from the automated release manifest
- exact build digest from the automated release manifest
- SHA-256 digest of this tracked procedure file
- screen-reader product and version
- operating-system name and version
- tester name
- UTC session start and assertion timestamps
- whether speech, braille, or both were used

The seven assertion timestamps must be monotonic, cannot be in the future, and must fall within four hours of the session start.

Do not test a development server, dirty worktree, or build whose digest differs from the automated certificate.

## Data fixture

Use the source-bound Release F certificate fixture. It must contain:

- a current Data view with at least three visible filtered and sorted rows
- at least one relation field
- at least one formula-hostile value such as `=1+1`
- a record-detail view for one visible row

## Current-view journey

1. Start at the trusted Data dialog.
2. Use keyboard navigation only to reach **Preview Print / CSV for current Data view**.
3. Activate it.
4. Confirm the screen reader announces a dialog named **Preview Print / CSV** and reads the local-only, preview-before-action description.
5. Confirm loading is announced through a live status and does not move focus unexpectedly.
6. Navigate the export manifest.
7. Confirm these policies are understandable from speech alone:
   - exact row and field count
   - current-view order and filter scope
   - friendly relation labels and whether IDs are excluded
   - attachments excluded
   - hidden and unselected fields excluded
   - redactions
   - complete, with no truncation
8. Navigate the preview table by row and column.
9. Confirm all headers are associated with their cells and row order is understandable.
10. Confirm the spreadsheet-safety disclosure for the formula-hostile cell is announced.
11. Navigate every advanced export policy checkbox and confirm its name and state.
12. Navigate Cancel, Download CSV, and Print / Save as PDF in logical order.
13. Activate Cancel and confirm focus returns to the current-view export trigger.

## Error and retry journey

1. Open the certificate's induced error state.
2. Confirm **Export preview unavailable** is announced as an alert.
3. Confirm the alert is connected to the dialog description.
4. Navigate to **Try again** and confirm its purpose is clear.
5. Activate retry and confirm loading is announced before success returns.

## Record-scope journey

1. Open one visible record's detail dialog.
2. Reach **Preview Print / CSV for this record** through keyboard navigation.
3. Activate it.
4. Confirm one record and the exact field count are announced.
5. Confirm headings and values match the selected record.
6. Confirm the same policy, table-header, formula-safety, and action semantics.
7. Exercise CSV and Print.
8. Close and confirm focus returns to the record export trigger.

## Transcript format

Supply one UTF-8 `.txt` transcript of at least 256 bytes. Every assertion uses a distinct nonoverlapping locator of this form:

`transcript-lines:<start>-<end>`

Line numbers are one-based and inclusive. The referenced range must exist, contain meaningful non-whitespace content, and include the exact marker `[<assertion-id>]`. One range cannot overlap another.

Example:

```text
[preview-table-navigation]
NVDA announced Title column 1 of 3, row 1 of 4.
Arrow navigation preserved the correct header and row association.
```

## Required pass assertions

Each item must have `status: "PASS"`, a concrete observation of at least 20 characters, its own UTC `performedAt`, the complete transcript artifact record, and a unique transcript line-range locator.

1. `dialog-status-and-error-announcements`
2. `manifest-policy-comprehension`
3. `preview-table-navigation`
4. `formula-neutralization-disclosure`
5. `controls-names-states-and-keyboard`
6. `focus-trap-and-restoration`
7. `current-view-and-record-journeys`

Any failed or unproven assertion keeps the release blocked. Do not weaken or omit failed observations.

## Evidence JSON

Create an external JSON document matching the strict PASS variant. Include:

- `status: "PASS"`
- `mode: "manual"`
- the supported product, product version, and platform
- session start in `performedAt`
- tester and bounded method description
- `procedure` with the exact ID, version, and current SHA-256 of this file
- exact source commit/tree and build digest
- exactly seven assertions in the required order
- one complete transcript artifact with relative filename, byte count, and SHA-256

Pass the JSON to:

`node scripts/verify-local-export.mjs --output <absolute external output> --manual-screen-reader <absolute external JSON>`

The verifier rejects evidence inside the source checkout or replaceable output directory, mismatched source/build/procedure identities, malformed or missing transcript ranges, overlaps, missing markers, invalid UTF-8, and unbound artifact bytes.
