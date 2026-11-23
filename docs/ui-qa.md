# UI QA checklist

Every stage that adds or changes CRM UI must pass this list before its PR. The automated part is
`e2e/layout.spec.ts` (runs in `pnpm test:e2e`); the rest is a manual pass. Use theme tokens and
shadcn conventions; no one-off colours or pixel hacks.

## Checklist

- **States**: default, hover, keyboard focus (visible and distinct from hover), disabled, loading
  (for example "Testing..."), error (field errors, failed toast) and empty (the empty message must
  read as intentional, not broken).
- **Viewports**: 1440, 1280, 1024, 768 and 390 px. No horizontal page scroll at any width; tables
  may scroll inside their own container only.
- **Dark mode**: every page and dialog in both themes. Text contrast stays readable, borders are
  single (no doubled borders), badges and focus rings are visible.
- **Focus and keyboard**: Tab order follows reading order; Escape closes every dialog, sheet and
  the palette; focus returns to the element that opened it. Dialogs from controlled state get this
  from `useReturnFocus` (built into our `DialogContent` and `AlertDialogContent`).
- **Overflow**: nothing sticks out of a dialog, card or table cell. In a flex or grid child that
  holds user text, set `min-w-0`; grid templates use `minmax(0,1fr)`; dialogs already apply it.
- **Long data**: test a 60+ character name, a long base URL, a 10-step route with long model names,
  a key label with emoji. User text in tables goes through `TruncatedText` (ellipsis plus a tooltip
  with the full value); text in dialogs wraps (`break-words` or `break-all` for tokens and URLs).
- **Names**: every icon-only button has an `aria-label`; badges never wrap (`whitespace-nowrap`).
- **Toasts** do not cover the header controls.
- **Motion**: honours `prefers-reduced-motion` (global rule in `src/app/globals.css`).

## Layout spec

```bash
pnpm build && pnpm start                      # the app, with ADMIN_* and DATABASE_URL set
E2E_ADMIN_USERNAME=<ADMIN_USERNAME> E2E_ADMIN_PASSWORD=<ADMIN_PASSWORD> pnpm test:e2e
```

`E2E_BASE_URL` (default `http://localhost:3000`) selects another port. `e2e/layout.spec.ts` seeds
long-named providers, a 10-step route and an emoji-labelled key through the admin API (idempotent,
reusing rows by name), then for each page in `src/components/app-shell/nav.ts` at 1440 and 390 px:

- no horizontal page scroll (`scrollWidth <= innerWidth`);
- every button and link has an accessible name;
- axe-core (`@axe-core/playwright`) reports no serious or critical violations, light and dark;

and for the provider, route, API key and palette dialogs: no visible descendant extends past the
dialog box, only one dialog is open after creating a key, Escape closes it and focus returns to
the opener. New pages are covered automatically because the spec iterates `allPages`; add new
dialogs to the dialog tests.

## Screenshots

`pnpm screenshots` (see [`screenshots/README.md`](screenshots/README.md)) regenerates
`docs/screenshots`. Run it against a fresh database so only demo data appears:

```bash
E2E_BASE_URL=http://localhost:3200 MOCK_UPSTREAM_PORT=4110 \
E2E_ADMIN_USERNAME=<ADMIN_USERNAME> E2E_ADMIN_PASSWORD=<ADMIN_PASSWORD> pnpm screenshots
```

Animations are disabled, dialogs are awaited until fully open with nothing closing behind them,
the seed reuses existing rows, and the "API key created" capture mocks the create response so no
extra keys are stored. Open the PNGs and review them against the checklist above.
