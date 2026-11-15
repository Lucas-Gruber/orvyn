# Spaces, hierarchy and permissions

## ADR 003: Deny-by-default inherited access

Personal spaces start owner-only. Space roles are Owner (implicit, stored on the space), Admin, Editor, Commenter and Viewer. Membership roles are ordered: 50, 40, 30, 20 and 10. Read requires 10, edit requires 30 and permission management requires 40. Comments themselves are not implemented yet.

Every page belongs to exactly one space. Composite foreign keys prevent cross-space parents, self-parent checks prevent direct cycles and the move API rejects descendant targets. Hierarchies are limited to 64 levels. The shared PostgreSQL function `orvyn_page_role` checks space membership plus every ancestor. At each restricted ancestor, an explicit user grant is required. Effective access is the minimum of space membership and all ancestor restrictions; a child never raises the access allowed by a parent. The space owner retains access. The site administrator flag does not bypass space permissions.

All resource reads, search, history, writes, page permission changes, trash and restore use this policy. Inaccessible resources return 404; list/search results omit them. Queries paginate at 100 records by default (maximum 200), using `after` and X-Next-Cursor. The UI offers loading more pages and preserves hierarchical indentation for loaded records.

## Team conversion and invitations

Only the space owner may convert a personal space. The UI first shows which root pages will remain restricted and requires explicit confirmation with a current space revision. Structural, title and permission changes invalidate that preview. Document-only edits do not change its permission scope. Conversion restricts existing roots, thereby preserving privacy of their descendants. New shared pages inherit team membership; existing pages require a separate explicit permission change to share them.

Verified owners/admins can email invitations. The recipient must sign in with the invited verified email and accept the one-use seven-day token. Wrong-account attempts do not consume invitations. Existing member roles are never silently changed by acceptance. Only the owner may invite/change administrators; admin removal is also reserved to the owner. Removing membership clears that user's page grants and their pending invitations, and resource access stops on subsequent requests. The collaboration service rechecks writes and outgoing frames against this same policy, and closes revoked connections.

## Moves, deletion and history

Moving a root freezes its previous audience as an explicit restricted grant set. The destination's restrictions can further reduce this audience; moving never silently broadens it. Cross-space moves are not supported yet. Move/delete require edit access to all descendants, so editing a parent does not permit destroying a private child. The current UI provides a keyboard-accessible parent selector; drag-and-drop ordering is outstanding.

Deletion is soft deletion. Descendants of a trashed page become inaccessible. Restore respects permissions and requires a live accessible parent. Independently trashed descendants stay in trash. Permanent deletion/retention policies are not implemented. Content saves create immutable page_revisions records; access to history is checked against the current page policy.

Space writes lock the space row before authorization-sensitive changes. REST page writes, permission updates and membership changes serialize on that lock. Collaborative content-only writes use a shared space lock plus a document advisory lock, so a concurrent revocation cannot commit in the middle of an authorized write. Further high-volume/performance tests are needed before large-workspace readiness is claimed.

## Remaining work

Organizations, ownership transfer, reusable groups, external sharing, database-record permissions, whiteboard/file permissions, administrative invitation revocation UI, comments, drag-and-drop and production permission stress tests remain open. The role model does not imply these resource types already exist.
