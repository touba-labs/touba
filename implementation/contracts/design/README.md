# Touba Design Tokens

This directory contains the versioned visual token contract shared by Touba
documentation site, Explorer, Traces and IDE surfaces.

The source contract is `touba-design-tokens-v1.json`. The CSS file is a direct
web export for Docusaurus, Tauri, and other web-based surfaces. Flutter and
native clients should derive their constants from the JSON contract.

Current consumers:

- A documentation site can keep a generated CSS snapshot at
  `src/css/touba-design-tokens-v1.css` and validates it against this contract
  when the full workspace is available.
- Touba IDE uses the same brand token family for icons and maps semantic roles
  to VS Code light and dark themes.
- Web readers consume the same canonical family.

## Interface requirements

Shared UI requirements use fixed application roles (12/14/18/24 px), flat underlined page submenus,
aligned controls, shared heading actions and compact in-app confirmations.
Product guides own their component mappings and responsive recipes; the JSON
remains the token source. Never hand-edit a generated consumer snapshot.

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
semantic contexts, hex color format, and the exported CSS values for each theme.
It does not verify layout, keyboard behavior, text contrast in a composed screen
or real browser responsiveness; run the affected product's UI recipe as well.
