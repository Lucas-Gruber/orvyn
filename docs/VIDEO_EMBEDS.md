# Supported video embeds

Use `/embed` or `/video`, paste a public HTTPS video URL and optionally enter a title. YouTube, Vimeo and Loom are supported. The URL is converted into a provider and bounded resource ID; tracking/query parameters and arbitrary iframe sources are not stored. Private Vimeo hash URLs and unsupported domains/ports/protocols are rejected.

Opening a document shows a local placeholder. No external player, thumbnail or provider metadata is requested until the reader chooses **Load video**. Loading and unloading are local view state, including for read-only readers, and do not create document revisions. Reloading starts with external content disabled again. Changes to a block's provider/resource also reset this choice.

The player URL is built from a fixed provider hostname/path. YouTube uses its `youtube-nocookie.com` embed hostname. Frames use `no-referrer` and a sandbox allowing scripts, same-origin provider behavior and presentation, without forms, popups or top-level navigation permissions. Player access and availability remain controlled by the provider. The application server never fetches the submitted URL and does not expose an arbitrary iframe HTML input.

Schema version 7 introduces the video reference node; migration 19 updates new-page defaults. Source documents, JSON exports and history store the provider/resource ID and authored title. Upgrade all app/collaboration replicas together and reload old editor tabs.

Tests cover URL normalization, invalid domains/credentials/ports/protocols, resource bounds, schema round trips, reloads, no network requests before an explicit load, canonical frame URLs/attributes, absence of referrer, local reader state and collaborative removal. Browser tests intercept the external player with a fixture: playback against the live providers, their changing policies and private-account videos has not been verified here.
