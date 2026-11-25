# README visuals

The root README uses these repository-owned assets rather than external image hosting.

The static badges in `badges/` are small SVG labels served from this repository. The release badge links to GitHub's latest release; it does not encode a version. The live build-status badge is served by GitHub Actions.

| Asset                                       | Source                                                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orvyn-hero.png`                            | AI-assisted marketing composition based on the real document and board screenshots below and the existing Orvyn icon. Its framing, background and typography are illustrative. |
| `workspace-light.png`, `workspace-dark.png` | Direct browser screenshots of the document editor in the Light and Graphite themes.                                                                                            |
| `roadmap-light.png`, `roadmap-dark.png`     | Direct browser screenshots of the same database's Board view in the Light and Graphite themes.                                                                                 |

The screenshots were captured from the running application at version **0.2.0** (source revision `84968476819036af92c4e636f142b1eeb261a4c3`) with Chromium, a 1600 × 1080 viewport and a 1.5 device scale factor. Application fonts were loaded before capture. No interface elements were redrawn or restyled for the screenshots.

The **Product studio** workspace, account, documents and roadmap records are fictional demo content created through the application API in a disposable test database and object bucket. The regular integration harness started the application services and removed its isolated data afterward. No production or personal workspace data appears in these assets.

When refreshing the images, capture a populated document and its related board from the current application, keep the viewport and themes consistent, and wait for saved content, loaded records and fonts. Preserve the original screenshots separately from any marketing composition. Use the source assets in [branding](../../branding/README.md) for the Orvyn mark.
