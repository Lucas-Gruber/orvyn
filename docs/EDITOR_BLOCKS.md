# Structured editor blocks

The slash menu includes **Callout**, **Toggle**, **Table of contents** and **Code block**. All block content and attributes use the same validated Yjs document, durable acknowledgements and history as normal text.

- Callouts contain normal rich blocks and have Info, Note, Success, Warning and Important styles. Editors can change their style; readers see the result without edit controls. `Ctrl/Cmd Enter` exits a callout into a paragraph after it.
- Toggles have an editable summary and rich block content. Enter in the summary moves into the body; `Ctrl/Cmd Enter` exits the toggle. Backspace in an empty summary unwraps its body. Collapse/expand is local view state, also available to read-only readers, and does not change the document or another reader's view.
- A table of contents derives its entries from the document's actual headings. Editing headings updates its labels; entries navigate through the permanent heading links. It contains no copied heading list in the saved document.
- Code blocks have a language selector and local Lowlight/Highlight.js syntax highlighting. Plain text is the default. Common languages are available without a network request. Highlighting changes presentation only; code stays text, including HTML-like strings. Readers cannot change the language. Triple Enter at the end exits a code block.

Styles use semantic theme tokens and locally bundled JetBrains Mono. Lowlight's MIT and Highlight.js's BSD license files are included under `apps/web/public/licenses`.

Schema version 4 adds callouts, toggle summaries/bodies and table-of-contents nodes. Migration 16 updates the default for new documents. Existing documents and Yjs histories are preserved. Upgrade the web app, API and all collaboration replicas together and reload open editor tabs; mixed-schema rolling upgrades are unsupported.

Shared schema tests cover nested round trips and invalid structures/styles. Chromium tests cover slash insertion, typing, collapse/expand, saved language/highlighting, local read-only toggling, live style updates, table-of-contents navigation and reload persistence. Images/files in document content, embeds, columns and generic multi-block dragging remain separate unfinished requirements.
