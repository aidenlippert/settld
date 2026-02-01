# Settld Helm Chart

This chart deploys:

- `settld-api` (HTTP API + `/metrics`)
- `settld-maintenance` (retention cleanup runner; separate process)
- optional `settld-receiver` (verify-on-receipt webhook consumer)

## Quick start

1) Create a secret containing `DATABASE_URL`:

```bash
kubectl create secret generic settld-db --from-literal=DATABASE_URL='postgres://...'
```

2) Install:

```bash
helm upgrade --install settld deploy/helm/settld \
  --set store.databaseUrlSecret.name=settld-db
```

## Export destinations + file secret refs

`PROXY_EXPORT_DESTINATIONS` is typically provided via the chart ConfigMap and should contain only **secret refs** (never inline secrets in production).

Mount secrets via `extraSecretMounts` and reference them using `file:/...` paths in `exportDestinationsJson`.

## Security defaults

Pods run with:

- non-root user
- dropped capabilities
- `readOnlyRootFilesystem: true`
- explicit `emptyDir` mounts for `/tmp` (and `/data` where needed)

