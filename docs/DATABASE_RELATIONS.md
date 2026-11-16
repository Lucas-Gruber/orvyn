# Database relations

Relation properties link records to a configured database in the same space, including the current database. A property can contain multiple records. The picker searches current readable targets, supports keyboard selection and opens records through permanent page links. Renames and access changes update open tables across collaboration replicas.

The server validates the target database when creating a property and validates every explicitly submitted record ID when saving values. Requests may select up to 50 currently readable records at a time. Previously stored inaccessible links remain stored, but are excluded from values, labels, filters and exports. Editing the visible selection preserves those unseen links. Explicitly submitting an inaccessible existing ID or an unknown ID produces the same validation error. The underlying stored list can therefore exceed 50 links after access changes and subsequent visible edits.

The transactional `record_relations` projection holds structural references, not permission snapshots. Queries resolve current source and target access. Relation filters (`contains`, equality and empty checks), saved views and CSV/JSON exports use that filtered projection. Scoped views return target metadata only for their visible relation columns. List sorting is unsupported. The picker does not disclose hidden counts or titles.

CSV import can map to an existing configured Relation property using UUID arrays (JSON or semicolon-separated IDs). Both preview and commit validate current readable targets; a changed permission at confirmation rejects the complete import. Creating a new relation directly from an unconfigured CSV column is unsupported.

Live subscriptions watch only currently readable related targets for the visible relation columns. A permission change removes a formerly readable target once; later activity on an inaccessible target sends no relation invalidation. A fingerprint of the HTTP snapshot is compared during watch registration so changes between loading and subscribing trigger a refresh. Fingerprints contain no content and do not authorize access; subscription records and targets are checked independently.

Current scope is one-way relations within a space. Automatic reciprocal properties, cross-space relations, formulas, rollups and templates remain separate work. There is no public sharing of relation targets.

Validation: `tests/database-relations.test.mjs` covers scope and role checks, hidden-ID probes, filtered query/export metadata, atomic CSV import, cross-replica invalidation, the initial subscription race and the Chromium property/picker/navigation flow.
