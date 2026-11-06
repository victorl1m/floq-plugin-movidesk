# floq-plugin-movidesk

Movidesk tickets as a read-only task source in Floq's Tasks.

- **Secrets:** MOVIDESK_TOKEN. Add them in Floq under Secrets; they never go in plugin settings.
- **Install:** Floq admins: Settings > Plugins > **Browse plugins** (catalog: `victorl1m/floq-plugins`), then enable the plugin.
- **Trust:** installed plugins run inside the Floq runtime with its full privileges. Floq checks the package sha256 against the catalog, but its plugin API is a guard rail, not a sandbox. Install only code you trust.
- **Status:** tested with mocked network calls only; not verified against the real service.

## Develop
```
npm install
npm test          # builds, validates with Floq's own parser (vendor/floq), runs the bundle against a fake context
npm run build     # dist/movidesk-<version>.floqpkg.json + dist/catalog-entry.json, rewrites ./catalog-entry.json
```
Release: bump `version` in plugin.json, `npm run build`, commit catalog-entry.json, tag `v<version>`, push the tag. Then copy the entry into the catalog repo.
Refresh the vendored parsers with `scripts/sync-vendor.sh /path/to/Floq`.
