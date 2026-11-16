# Database formulas

Formula properties compute read-only numbers, text or booleans from the current record. Create them with Add a property → Formula; click a formula column heading to edit its name/expression. The editor checks types, offers property insertion and retains an expression when the server rejects it. Schema-version conflicts require reopening the editor; stale edits never overwrite another schema change.

Use double-quoted strings and `prop("Property name")`, for example:

```
prop("Hours") * prop("Rate")
if(prop("Estimate") >= 1000, "Review", "Ready")
concat(prop("Name"), ": ", format(coalesce(prop("Estimate"), 0)))
length(prop("Related work"))
```

Property names resolve to stable IDs at save time. Existing calculations survive renames. Reopening the editor renders current property names. Ambiguous names must be renamed before inserting/saving an expression. Formulas may refer to other formula properties; cyclic dependencies, incompatible types and excessive complexity are rejected.

Supported operators: `+ - * / %`, unary `+ - !`, `== != > >= < <=`, `&& ||`. Text `+` joins strings. Functions: `if`, `coalesce`, `empty`, `length`, `abs`, `ceil`, `floor`, `round`, `min`, `max`, `lower`, `upper`, `trim`, `concat`, `contains`, `format`. Lists are accepted by `length`/`empty` and compatible conditional/coalesce expressions; a formula cannot return a list. Select/status references produce labels, multi-select references produce label lists, Person references contain IDs, Files references contain ready attachment IDs and Relation references contain current readable record IDs. Dates and creation/edit timestamps are text; date arithmetic and volatile functions such as `now()` are not implemented.

Numbers use finite double precision. Invalid arithmetic, division/modulo by zero and numeric overflow return null. Arithmetic propagates null. `if` treats a null condition as false. `coalesce` uses the first non-null argument. `min`/`max` ignore null arguments. `length(null)` is zero; `empty` recognizes null, empty text and empty lists (zero and false are nonempty). Text concatenation and `format` treat null as empty text; strings are limited to 10,000 characters. Rounding follows PostgreSQL double-precision rounding. Equality treats two nulls as equal. String comparisons/case operations follow the database locale.

There is no JavaScript evaluation, user SQL, network access or arbitrary function invocation. The parser limits source length (2,000 characters), nodes (128), nesting (16) and expanded dependencies (512 expressions, depth 32). The SQL compiler uses a fixed operator/function allowlist and binds all literals/property IDs. Numeric operations run through an immutable bounded helper; results are computed in the query before filtering, sorting or pagination. Record mutation responses, saved views and CSV/JSON exports use the same calculation. Computed values cannot be patched or imported; CSV matching skips their columns.

Relations inside formulas use current permission-filtered projections. Hidden targets do not affect counts, filters or exports. Live subscriptions include relation dependencies of visible formula columns and filters/sorts even when the Relation column is hidden. Refresh/requery uses current permissions. Target invalidations currently watch the loaded source records; target-only changes affecting records outside the loaded result/page may require refreshing to include a newly matching record. Formula exports contain computed values and their definitions, not a portable restore facility.

Validation: `tests/database-formulas.test.mjs` exercises parser bounds and type errors, stable references, numeric/text/boolean calculation, null/overflow behavior, cycles and stale schema edits, read-only values/CSV import, server-side query pagination and exports, private relation dependencies, cross-replica refresh and the Chromium create/edit/filter/reload flow.
