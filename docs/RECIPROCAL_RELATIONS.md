# Two-way database relations

When creating a Relation property, select its related database and enable **Show a matching property in the related database**. Name the matching property before adding it. Setup requires editor access to both database schemas. The picker suggests an unused name; the server rejects a matching name already in the target schema. Self-relations create two separately named properties in the same database.

Both properties behave as normal Relation fields. Adding or removing a link from either side updates the other side in the same transaction. Editing links requires editor access to the record being edited and reader access to explicitly selected targets; this does not grant general editing rights to those targets. The paired setup authorizes maintenance of the matching relation field only. Related records' other values and authored document metadata are unchanged. Automatic maintenance advances their record revisions and uses the existing permission-filtered database notifications.

Every read applies current permissions independently to both linked records. Private/inaccessible links remain stored and are excluded from field values, labels, formulas, rollups, picker results and exports. Editing a visible selection retains its unseen links. Each paired property supports at most **50 stored links per record**, including retained inaccessible links. Exceeding either side's capacity rejects the complete operation. Record creation, CSV import and template application cannot leave a partial record or half a relationship.

## Persistence and concurrency

Migration 37 adds `database_relation_pairs`, with property foreign keys and a canonical ordering of each pair. Both property configurations include the matching `reciprocalPropertyId`. Setup locks the participating spaces in a stable order before creating either schema entry. Record writes hold the pair registration while locking every affected record in UUID order before the source revision is changed. Concurrent opposite edits therefore use optimistic conflicts rather than losing one side. Bulk imports lock all of their matching targets before processing rows, including when different source spaces share target records.

Matching updates change only the relation field on the opposite record and increment that record's revision. Existing unrelated pending cell edits can use the normal record-draft conflict/rebase handling. Document content and identity are preserved. Self-links maintain both diagonal entries; contradictory explicit edits to the two diagonal fields are rejected.

## Deletion and templates

Deleting either property disconnects the pair and retains both properties' record values. The surviving property becomes one-way. Restoring the deleted property keeps its original values as an independent one-way relation; it does not overwrite later choices by reconnecting automatically. The registry's deletion trigger also clears matching metadata during physical foreign-key cleanup. The property manager explains this behavior before deletion.

Record templates copy their currently authorized defaults and maintain matching fields when applied to the original database. Database templates preserve self-pairs with independent property IDs and registrations. A paired external relation becomes a one-way relation in a schema clone: cloning a database does not modify the original target's schema or attach the new database to its original matching property. Normal cross-space target-access checks still apply.

Existing one-way properties are preserved. Converting an existing populated one-way property into a pair or reconnecting two existing fields is not implemented; create a new paired property instead. Multi-hop rollups remain separate work.

## Verification

`tests/reciprocal-relations.test.mjs` exercises setup roles, independent editing rights, writes/removals from both sides, hidden inverse links and formulas, concurrent opposite edits, self-links and contradictory diagonal updates, record/schema templates, deletion/restoration, the capacity boundary with atomic CSV rollback and no partial creation, simultaneous imports sharing target records, and real Chromium setup, editing in both open databases, live reverse updates, reload, read-only target explanations and mobile geometry.
