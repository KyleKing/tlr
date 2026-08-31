# Next steps

## app-template re-seeds its scaffolding on every update

`src/routes.ts`, `src/templates/pages/home.vto`, and `src/templates/partials/nav.vto`
are in app-template's `_skip_if_exists`, which only skips a file that already exists.
They were deleted here because tlr serves from `web/`, so copier renders them again on
every update and they get deleted again. Twice so far, 0.2.0 to 0.2.1 and 0.2.1 to
v0.3.0.

The usual escape (leave the file in place but empty) does not work here, because
`src/` is tlr's real source tree and an empty `src/routes.ts` among fifty real modules
reads as a bug rather than a placeholder.

The fix belongs upstream: gate those three on a copier answer so a project that does
not serve from `src/` never receives them. app-template already renders a `demo` case
that does want them.

## Biome config schema is a version behind

`deno task biome` warns that the pinned config schema is 2.2.4 while the resolved
binary is 2.5.5. Non-gating today. `biome migrate` closes it.

## `.impeccable/hook.cache.json` shows up as unformatted

It is gitignored, but a local `deno fmt` still walks it and reports it. Add it to the
formatter's exclude so the output stays readable.
