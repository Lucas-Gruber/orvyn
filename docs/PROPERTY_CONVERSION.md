# Reviewed scalar property conversion

Space owners can open a scalar property in **Database properties → Change type…**, choose Text, Number, Date, Checkbox, URL, Email or Phone and review a concrete snapshot before applying it. Other schema editors retain normal property editing and see that changing the type requires the space owner. Selection/reference/computed fields and the title are not convertible through this path.

The preview includes every record in the database, including restricted and archived records, up to 5,000 records. It shows changed/cleared counts, up to 20 representative examples and affected views. Incompatible values become null only after the owner explicitly acknowledges that result. No record, schema or history changes during preview. Larger databases return a clear limit without applying a partial conversion; batch conversion remains future work.

Numbers accept finite decimal/scientific values and booleans, rejecting ambiguous separators, hexadecimal and overflow. Checkbox conversion accepts booleans, 0/1 and explicit English/German true/false words. Dates require valid ISO calendar dates. Other scalar targets use the existing field validators; unsafe URLs and invalid email/date values become empty in the review. Missing fields, JSON null, false, zero and empty strings retain distinct backup representations.

## Snapshot and atomicity

Preview tokens expire after ten minutes and use a domain-separated HMAC key derived from the instance encryption key. They contain no source values. The token binds the owner, database/property, target/history choice, schema, record values/versions/titles/trash state and saved-view revisions. Applying a stale preview returns a conflict and requires a fresh review.

Applying holds the source-space write lock, locks record rows in UUID order and commits the field type, changed values, original backups, view repairs, search projections and activity together. A failed write rolls all of them back. Requests use a property-scoped idempotency UUID so a lost response can be retried without applying twice. Only records whose stored field value changes get a new record version; unrelated values and document contents remain untouched.

Incompatible local formula result types block conversion. Other databases continue to resolve target schemas under their own current permissions; rollups that no longer support the new type become unavailable through the existing rollup rules. Field filters/sorts are removed, calendars using a converted date field become tables, and explicit column widths are raised to the target type's minimum. Field IDs, names, display order, visibility and unrelated view settings remain stable.

## Original values and history

Migration 40 adds property-change metadata and per-record original/converted values. History and restoration previews require current space ownership; originals are not serialized in normal metadata, search, exports, templates or reader events. Backups cascade when their property or record is physically deleted, and soft deletion retains them for restoration.

History loads 20 changes at a time with **Load older changes**, a visible count and an end state. Its cursor refers to an existing change in this exact field. PostgreSQL resolves the original microsecond timestamp and stable ID order, so identical timestamps do not drop/duplicate entries and newly added changes do not shift an in-progress page. Refreshing the field starts again with the latest history. The old latest-20 array endpoint remains compatible; the UI uses `GET /api/v1/databases/:id/properties/:property/type-history/page?after=<change UUID>`, returning `{changes,nextCursor,propertyType}`. Missing/foreign/malformed cursors fail explicitly, and every page checks current ownership and field availability.

A failed older-page request retains loaded rows and the cursor for retry. Closing/reopening the dialog ignores late responses. If a loaded page reports a changed field type, restoration controls require a fresh field/history load. Older changes use the same signed, current-data restoration review as recent ones. The history list scrolls within the dialog and remains usable on mobile.

**Review restore** prepares another owner-reviewed conversion to the previous type. A value still matching the prior converted value restores its exact original, including leading zeroes and empty/missing distinctions. Newer edits and newly created records convert from their current values instead of being overwritten with old content. Each restore keeps a new set of originals, so the operation remains reviewable in history. Newer view choices are repaired for the requested type rather than overwritten with historical settings.

## Verification

`tests/property-conversion.test.mjs` exercises scalar rules, owner-only access, private/trash inclusion, read-only previews, explicit clearing, scoped signed tokens, stale record/schema/view previews, idempotence, original restoration with newer edits, view/width repair, formula guards, the record cap, token expiry and an injected failure after schema/view changes proving complete rollback. `tests/property-conversion-browser.test.mjs` covers review/acknowledgement/history/restore, editor-role UI, mobile geometry, stale reviews, a lost committed response and closing/reopening an in-flight preview.

`tests/property-history.test.mjs` additionally covers multiple cursor pages with tied timestamps, newer insertions, exact restoration from an older conversion, compatible legacy responses, current owner/field checks, malformed/foreign/deleted cursors, retained failed reads, late-response isolation and changed-type reloads in Chromium desktop/mobile flows.
