# Touba Design Tokens

This directory contains the versioned visual token contract shared by Touba
documentation site, Cloud, client, Explorer, Traces and IDE surfaces.

The source contract is `touba-design-tokens-v1.json`. The CSS file is a direct
web export for Docusaurus, Tauri, and other web-based surfaces. Flutter and
native clients should derive their constants from the JSON contract.

Current consumers:

## Interface requirements

## Themes

The contract defines two semantic contexts:

- `light`: white-first UI, with `#ffffff` as the primary surface.
- `dark`: dark operational UI, with light text and Touba blue accents.

The white token is explicit and must remain available in both themes for text,
surfaces, icons, and contrast-safe primary actions.

## Validation

Run:

```bash
pnpm validate:design-tokens
pnpm test:design-tokens
```

The validator checks schema identity, required palette tokens, light/dark
semantic contexts, hex color format, and CSS coverage.
It does not verify layout, keyboard behavior, text contrast in a composed screen
or real browser responsiveness; run the affected product's UI recipe as well.
