Local brand marks
==================

This folder is for YOUR OWN files, on YOUR OWN machine. Nothing in it is
committed to the repo except this README, and nothing in it is shipped in the
public project.

By default, the map badges and the exported report show a neutral text label
for a handful of well-known chains (Starbucks, Kroger, Target, Walmart,
Walgreens) -- no logo artwork is bundled, because those logos are trademarks
of their owners and this is a public open-source project.

If you want your own local copy to show the real logo instead, drop a file
in this folder named exactly after the chain key, for example:

  kroger.png
  starbucks.svg
  target.jpg
  walmart.webp
  walgreens.png

Rules:
- The filename must be exactly "<chain-key>.<extension>" -- one of the chain
  keys above, one dot, one of: png, svg, jpg, jpeg, webp. Anything else is
  ignored (not served, not an error).
- One file per chain. If more than one extension exists for the same key,
  the app picks one deterministically; it does not merge them.
- These are trademarks. You are responsible for having the right to use
  whatever image you place here, on your own machine, for your own use.
  Do not commit these files or redistribute them.

With no file for a chain, the map and report keep showing that chain's
neutral label -- this is optional, and nothing breaks without it.

See README.md's "Local brand marks (optional)" section for how the app
serves these files and where the map/report use them.
