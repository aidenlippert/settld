# Vercel Monorepo Deploy (Docs + Website)

Use **two separate Vercel projects** pointing at the same GitHub repo:

1. `settld-docs` (MkDocs)
2. `settld-site` (Dashboard website)

## Project 1: `settld-docs` (MkDocs)

- Root Directory: repo root (`.`)
- Production Branch: `main`
- Build/Output config comes from `/vercel.json`:
  - `installCommand`: `bash scripts/vercel/install-mkdocs.sh`
  - `buildCommand`: `bash scripts/vercel/build-mkdocs.sh`
  - `ignoreCommand`: `bash scripts/vercel/ignore-mkdocs.sh`
  - `outputDirectory`: `mkdocs/site`

Deploy will run when docs-relevant files change (including `mkdocs/docs/**`).

## Project 2: `settld-site` (Website)

- Root Directory: `dashboard`
- Production Branch: `main`
- Build/Output config comes from `/dashboard/vercel.json`:
  - `installCommand`: `npm install`
  - `buildCommand`: `npm run build`
  - `ignoreCommand`: `bash ../scripts/vercel/ignore-dashboard.sh`
  - `outputDirectory`: `dist`

Deploy will run when website-relevant files change (`dashboard/**` + deploy scripts/workflows).

## Push Flow

1. Commit and push changes to `main`.
2. Verify both Vercel projects are connected to this repo and track `main`.
3. Check the commit SHA in each Vercel deployment detail page matches the pushed commit.

## Quick Troubleshooting

- Docs didn’t deploy: confirm changes touched `mkdocs/docs/**` or another path matched by `scripts/vercel/ignore-mkdocs.sh`.
- Website didn’t deploy: confirm changes touched `dashboard/**` or another path matched by `scripts/vercel/ignore-dashboard.sh`.
- Wrong commit deployed: confirm Vercel project production branch is `main`, not a feature branch.
