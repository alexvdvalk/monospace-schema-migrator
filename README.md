# Monospace Schema Migrator

Interactive scripts for copying a data model (collections, fields, indexes and relations) from one Monospace workspace to another. No rows are copied: only the schema.

The work happens in two steps:

1. **Extract** reads the schema of one or more data sources in a workspace and writes it to JSON files, one per source.
2. **Apply** reads those files and creates the collections and relations in a destination workspace.

The extract files are plain JSON, so you can commit them, review them, or apply them to several workspaces.

## Requirements

- [Bun](https://bun.sh)
- An API token for each Monospace instance involved:
  - Source: `dataModel:read` and `dataSource:read`
  - Destination: the same, plus `dataModel:edit`
- The destination workspace needs at least one data source to write into.

```sh
bun install
```

## Extract

```sh
bun run migrate:extract
```

The script asks for:

1. **Source Monospace URL** (defaults to `http://localhost:8100`) and an **API token**.
2. **Workspace**, picked from the workspaces the token can see.
3. **Databases to extract**: the workspace's data sources, each shown with its provider and collection count. The built-in system database is excluded.
4. **Output directory**: defaults to `migrations/<workspace>`.

Each selected source is written to `<output dir>/<source apiName>.json`. If a file already exists, you're asked before it's overwritten.

If a source has relations to another source that you didn't select, you'll see a warning. Those relations are skipped on apply unless you extract the other source too.

## Apply

```sh
bun run migrate:apply                # prompts, shows the plan, asks before applying
bun run migrate:apply --dry-run      # prompts and shows the plan, applies nothing
bun run migrate:apply --out m.json   # also writes the migration payloads to m.json
```

The script:

1. Asks for a **directory** (default `migrations`) and finds all extract files in it, including subdirectories. You pick which to apply. You can't pick two files for the same origin database.
2. Asks for the **destination URL, token and workspace**.
3. Asks for a **destination data source** for each extracted database, or lets you skip it. A source with the same name and provider is preselected. If you pick a source with a different provider, some field types may not be supported.
4. Shows a **plan**: how many collections and relations will be created, and how many are already present or skipped, followed by any warnings.
5. Asks for confirmation, then runs two migrations against `POST /schema/migrate`:
   - **collections**: creates each new collection with its fields and indexes.
   - **relations**: re-reads the destination schema to get the new IDs, then creates each relation as a field pair, keeping the original constraint name and `onDelete` / `onUpdate` rules.

With `--out`, the operations sent (or, with `--dry-run`, the operations that would be sent) are written to a JSON file. In a dry run, relations between collections that don't exist yet are listed as `{ "pending": "..." }`, because their IDs aren't known until the collections exist.

### Re-running

Apply is safe to run more than once:

- Collections that already exist in the destination (matched by `apiName`) are skipped.
- Relations are skipped if either of their fields already exists.

Apply does **not** compare existing collections against the extract. If a collection exists but is missing fields, or lives in a different data source, apply prints a warning and leaves it unchanged. You'll need to fix those differences yourself.

## Extract file format

```jsonc
{
  "formatVersion": 1,
  "extractedAt": "2026-11-23T15:00:00.000Z",
  "origin": {
    "url": "http://localhost:8100",
    "workspace": "hotels",
    "source": { "apiName": "main", "provider": "postgres" }
  },
  "collections": [
    {
      "apiName": "rooms",
      "dbName": "rooms",
      "fields": [
        { "apiName": "id", "dbName": "id", "type": { "name": "uuid" }, "isNullable": false, "isList": false }
      ],
      "indexes": [
        { "dbName": "rooms_pkey", "kind": "primary", "fields": ["id"] }
      ],
      "relations": [
        {
          "apiName": "hotel",
          "target": { "source": "main", "collection": "hotels" },
          "oppositeField": "rooms",
          "isList": false,
          "isForward": true,
          "linking": [{ "local": "hotel_id", "target": "id" }],
          "constraint": { "dbName": "rooms_hotel_fkey", "onDelete": "CASCADE" }
        }
      ]
    }
  ]
}
```

Field, index and relation references use `apiName`s rather than instance IDs, so a file can be applied to any workspace. Values above are illustrative.

## Project layout

```
src/migrate/
  extract.ts   extract CLI
  apply.ts     apply CLI
  shared.ts    prompts, HTTP helper, schema manifest decoder (GET /schema), extract file types
```

## Limitations

- Schema only. No data, permissions, or other workspace settings are copied.
- Existing collections are not updated (see [Re-running](#re-running)).
- If two selected files define a collection with the same `apiName`, only the first is applied. The other is skipped with a warning.
- Only schema manifest `formatVersion` 1 is supported.
