# Orvyn identity

The folded purple ring combines an **O** with a document corner. The generated transparent PNG masters live in `source/`: an icon and horizontal wordmarks for light and dark surfaces. Use the icon with the existing accessible Orvyn name in application navigation.

`desktop/` contains 16–1024 px PNGs, a Windows multi-resolution ICO, and a macOS ICNS containing PNG representations. These are assets for future desktop packaging; Orvyn currently ships the server and web application.

Run `node scripts/branding.mjs` with ImageMagick 7 installed to reproduce the exports. It preserves the masters and strips metadata from resized PNGs. Web favicons, Apple touch icon, and the Rancher/Helm icon are copied from the same source. Keep clear space around the mark; do not stretch it.
