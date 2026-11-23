// Applies data-model JSON files written by extract.ts to a Monospace workspace. For each
// extracted database you pick a destination data source, or skip it.
//
//   bun run migrate:apply               # prompts, shows the plan, asks before applying
//   bun run migrate:apply --dry-run     # prompts and shows the plan, applies nothing
//   bun run migrate:apply --out m.json  # also write the migration payloads to a file
//
// Re-runnable: collections that already exist in the destination (by apiName) are skipped, and
// so are relations whose field already exists. New fields on an already-copied collection are
// not diffed — they are reported as warnings.
import { parseArgs } from 'node:util';
import * as p from '@clack/prompts';
import { answer, connect, listSources, orExit, readModel, request, type Collection, type ExtractFile, type LiveCollection, type Source } from './shared';

const { values: args } = parseArgs({
	args: Bun.argv.slice(2),
	options: { 'dry-run': { type: 'boolean', default: false }, out: { type: 'string' } },
});
const dryRun = args['dry-run'];

p.intro(`Monospace data model — apply${dryRun ? ' (dry run)' : ''}`);

// ---------------------------------------------------------------------------------------------
// 1. Pick extract files

const dir = answer(await p.text({ message: 'Directory with extracted JSON files', placeholder: 'migrations', defaultValue: 'migrations' })).replace(/\/$/, '');

type Loaded = { key: string; path: string; file: ExtractFile };
const found: Loaded[] = [];
for await (const rel of new Bun.Glob('**/*.json').scan({ cwd: dir, onlyFiles: true })) {
	const path = `${dir}/${rel}`;
	try {
		const file = (await Bun.file(path).json()) as ExtractFile;
		if (file?.formatVersion !== 1 || !file.origin?.source || !Array.isArray(file.collections)) continue;
		found.push({ key: `${file.origin.workspace}/${file.origin.source.apiName}`, path, file });
	} catch {
		// not an extract file
	}
}
if (!found.length) {
	p.log.error(`No extract files found in ${dir}. Run bun run migrate:extract first.`);
	process.exit(1);
}
found.sort((a, b) => a.path.localeCompare(b.path));

const files = answer(
	await p.multiselect({
		message: 'Database models to apply',
		options: found.map((f) => ({
			value: f,
			label: f.path,
			hint: `${f.file.origin.workspace}/${f.file.origin.source.apiName} (${f.file.origin.source.provider}), ${f.file.collections.length} collections`,
		})),
		initialValues: found,
		required: true,
	}),
);
const dupes = files.map((f) => f.key).filter((k, i, a) => a.indexOf(k) !== i);
if (dupes.length) {
	p.log.error(`Selected more than one file for the same database: ${[...new Set(dupes)].join(', ')}`);
	process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// 2. Destination workspace and source mapping

const dest = await connect('Destination', 'https://');
const destSources = await orExit(listSources(dest), 'read data sources', dest);
if (!destSources.length) {
	p.log.error(`Workspace "${dest.workspace}" has no data sources to write to.`);
	process.exit(1);
}

const target = new Map<string, Source>(); // file key → destination source
for (const f of files) {
	const { apiName, provider } = f.file.origin.source;
	const preferred = destSources.find((s) => s.apiName === apiName && s.provider === provider) ?? destSources.find((s) => s.provider === provider);
	const choice = answer(
		await p.select<Source | null>({
			message: `Destination for ${f.key} (${provider})`,
			options: [
				...destSources.map((s) => ({ value: s as Source | null, label: s.apiName, hint: s.provider === provider ? s.provider : `${s.provider} — different provider, types may not be supported` })),
				{ value: null, label: 'Skip this database' },
			],
			initialValue: preferred ?? null,
		}),
	);
	if (choice) target.set(f.key, choice);
}
if (!target.size) {
	p.outro('All databases skipped. Nothing to do.');
	process.exit(0);
}
const active = files.filter((f) => target.has(f.key));

// ---------------------------------------------------------------------------------------------
// 3. Plan collections

const s = p.spinner();
s.start(`Reading ${dest.workspace} schema`);
let destModel = await orExit(readModel(dest), 'read the schema', dest);
s.stop(`Read ${dest.workspace} schema (${[...destModel.values()].filter((c) => !c.isSystem).length} collections)`);

const warnings: string[] = [];
const byKey = new Map<string, Map<string, Collection>>(active.map((f) => [f.key, new Map(f.file.collections.map((c) => [c.apiName, c]))]));
const claimed = new Map<string, string>(); // collection apiName → file key that creates it

const collectionOps: unknown[] = [];
let existingCount = 0;
for (const f of active) {
	const sourceId = target.get(f.key)!.id;
	for (const c of f.file.collections) {
		if (claimed.has(c.apiName)) {
			warnings.push(`${f.key}: collection ${c.apiName} also comes from ${claimed.get(c.apiName)}; skipped`);
			continue;
		}
		claimed.set(c.apiName, f.key);
		const existing = destModel.get(c.apiName);
		if (existing) {
			existingCount++;
			const missing = c.fields.filter((x) => !existing.fieldIds.has(x.apiName)).map((x) => x.apiName);
			if (missing.length) warnings.push(`${c.apiName} already exists but lacks fields: ${missing.join(', ')}`);
			if (existing.source !== target.get(f.key)!.apiName) warnings.push(`${c.apiName} already exists in source ${existing.source}, not ${target.get(f.key)!.apiName}`);
			continue;
		}
		const fieldId = new Map(c.fields.map((x) => [x.apiName, crypto.randomUUID()]));
		collectionOps.push({
			kind: 'createCollection',
			data: {
				id: crypto.randomUUID(),
				sourceId,
				dbName: c.dbName,
				apiName: c.apiName,
				operations: [
					...c.fields.map((x) => ({
						kind: 'createPrimitiveField',
						data: {
							id: fieldId.get(x.apiName)!,
							dbName: x.dbName,
							apiName: x.apiName,
							type: x.type,
							isNullable: x.isNullable,
							isList: x.isList,
							...(x.defaultValue === undefined ? {} : { defaultValue: x.defaultValue }),
						},
					})),
					...c.indexes.map((ix) => ({
						kind: 'createIndex',
						data: { id: crypto.randomUUID(), dbName: ix.dbName, kind: ix.kind, fieldIds: ix.fields.map((n) => fieldId.get(n)!) },
					})),
				],
			},
		});
	}
}

// ---------------------------------------------------------------------------------------------
// 4. Plan relations. Each pair is visited once, from the forward (foreign-key) side when there is
//    one. Ids come from the destination, so in a real run this is planned after step 5.

function planRelations(model: Map<string, LiveCollection>) {
	const ops: unknown[] = [];
	const pending: string[] = []; // dry run: relations whose collections don't exist yet
	const skipped: string[] = [];
	const seen = new Set<string>();
	for (const f of active) {
		for (const c of f.file.collections) {
			if (claimed.get(c.apiName) !== f.key) continue;
			for (const r of c.relations) {
				const label = `${c.apiName}.${r.apiName} ⇄ ${r.target.collection}.${r.oppositeField}`;
				const pair = [`${c.apiName}.${r.apiName}`, `${r.target.collection}.${r.oppositeField}`].sort().join('|');
				if (seen.has(pair)) continue;

				const targetKey = `${f.file.origin.workspace}/${r.target.source}`;
				const other = byKey.get(targetKey)?.get(r.target.collection);
				if (!other || claimed.get(other.apiName) !== targetKey) {
					seen.add(pair);
					skipped.push(`${label} (${r.target.source} not applied)`);
					continue;
				}
				const opposite = other.relations.find((o) => o.apiName === r.oppositeField);
				if (!opposite) throw new Error(`${targetKey}: ${other.apiName}.${r.oppositeField} missing from extract`);
				if (!r.isForward && opposite.isForward) continue; // handled from the other side
				seen.add(pair);

				const first = model.get(c.apiName);
				const second = model.get(other.apiName);
				if (!first || !second) {
					pending.push(label);
					continue;
				}
				if (first.relations.some((x) => x.apiName === r.apiName) || second.relations.some((x) => x.apiName === opposite.apiName)) continue;

				const fid = (col: LiveCollection, name: string) => {
					const id = col.fieldIds.get(name);
					if (!id) throw new Error(`${dest.workspace}: field ${col.apiName}.${name} not found`);
					return id;
				};
				const constraint = r.constraint ?? opposite.constraint;
				ops.push({
					kind: 'createRelationFieldPair',
					data: {
						kind: 'single',
						data: {
							relationName: constraint?.dbName ?? `${c.apiName}_${r.apiName}`,
							...(constraint?.onDelete ? { onDelete: constraint.onDelete } : {}),
							...(constraint?.onUpdate ? { onUpdate: constraint.onUpdate } : {}),
							firstField: { id: crypto.randomUUID(), apiName: r.apiName, isList: r.isList, isConstrained: !!r.constraint, collectionId: first.id, fieldIds: r.linking.map((l) => fid(first, l.local)) },
							secondField: { id: crypto.randomUUID(), apiName: opposite.apiName, isList: opposite.isList, isConstrained: !!opposite.constraint, collectionId: second.id, fieldIds: r.linking.map((l) => fid(second, l.target)) },
						},
					},
				});
			}
		}
	}
	return { ops, pending, skipped };
}

// ---------------------------------------------------------------------------------------------
// 5. Show plan, confirm, apply

const preview = planRelations(destModel);
const relationCount = preview.ops.length + preview.pending.length;
p.note(
	[
		...active.map((f) => `${f.key}  →  ${dest.workspace}/${target.get(f.key)!.apiName}`),
		...files.filter((f) => !target.has(f.key)).map((f) => `${f.key}  →  skipped`),
		'',
		`Collections to create: ${collectionOps.length}  (already present: ${existingCount})`,
		`Relations to create:   ${relationCount}  (skipped: ${preview.skipped.length})`,
	].join('\n'),
	`Plan for ${dest.host}`,
);
for (const x of preview.skipped) warnings.push(`relation ${x}`);
for (const w of warnings) p.log.warn(w);

const migrations: { phase: string; operations: unknown[] }[] = [{ phase: 'collections', operations: collectionOps }];

if (dryRun) {
	migrations.push({ phase: 'relations', operations: [...preview.ops, ...preview.pending.map((relation) => ({ pending: relation }))] });
	if (args.out) await Bun.write(args.out, JSON.stringify(migrations, null, '\t') + '\n');
	p.outro(`Dry run — nothing applied.${args.out ? ` Migrations written to ${args.out}.` : ''}`);
	process.exit(0);
}
if (!collectionOps.length && !relationCount) {
	p.outro('Destination is already up to date.');
	process.exit(0);
}
if (!answer(await p.confirm({ message: `Apply to ${dest.workspace}?`, initialValue: false }))) {
	p.cancel('Nothing applied.');
	process.exit(0);
}

try {
	if (collectionOps.length) {
		s.start(`Creating ${collectionOps.length} collections`);
		await request(dest, 'POST', '/schema/migrate', { operations: collectionOps });
		destModel = await readModel(dest); // pick up the new collection + field ids
		s.stop(`Created ${collectionOps.length} collections`);
	}
	const { ops: relationOps, pending } = planRelations(destModel);
	for (const x of pending) p.log.warn(`relation ${x}: collection missing in destination; skipped`);
	migrations.push({ phase: 'relations', operations: relationOps });
	if (relationOps.length) {
		s.start(`Creating ${relationOps.length} relations`);
		await request(dest, 'POST', '/schema/migrate', { operations: relationOps });
		s.stop(`Created ${relationOps.length} relations`);
	}
} catch (e) {
	s.error('Migration failed');
	p.log.error((e as Error).message);
	process.exit(1);
} finally {
	if (args.out) await Bun.write(args.out, JSON.stringify(migrations, null, '\t') + '\n');
}

p.outro(`Done.${args.out ? ` Migrations written to ${args.out}.` : ''}`);
process.exit(0); // clack leaves stdin open
