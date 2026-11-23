// Extracts the data model (collections, fields, indexes, relations — no rows) of selected data
// sources in a Monospace workspace into JSON files, one per source. Apply them with apply.ts.
//
//   bun run migrate:extract
import * as p from '@clack/prompts';
import { answer, connect, listSources, orExit, readModel, toExtract } from './shared';

p.intro('Monospace data model — extract');

const conn = await connect('Source', 'http://localhost:8100');

const sources = await orExit(listSources(conn), 'read data sources', conn);
if (!sources.length) {
	p.log.error(`Workspace "${conn.workspace}" has no data sources.`);
	process.exit(1);
}

const s = p.spinner();
s.start('Reading schema');
const model = await orExit(readModel(conn), 'read the schema', conn);
s.stop('Schema read');

const count = (source: string) => [...model.values()].filter((c) => !c.isSystem && c.source === source).length;
const picked = answer(
	await p.multiselect({
		message: 'Databases to extract (space to toggle, enter to confirm)',
		options: sources.map((src) => ({ value: src, label: src.apiName, hint: `${src.provider}, ${count(src.apiName)} collections` })),
		required: true,
	}),
);

const outDir = answer(
	await p.text({ message: 'Output directory', placeholder: `migrations/${conn.workspace}`, defaultValue: `migrations/${conn.workspace}` }),
).replace(/\/$/, '');

const written: string[] = [];
for (const src of picked) {
	const extract = toExtract(conn, src, model);
	const path = `${outDir}/${src.apiName}.json`;
	if (await Bun.file(path).exists()) {
		const overwrite = answer(await p.confirm({ message: `${path} exists. Overwrite?`, initialValue: false }));
		if (!overwrite) {
			p.log.warn(`Skipped ${src.apiName}`);
			continue;
		}
	}
	await Bun.write(path, JSON.stringify(extract, null, '\t') + '\n');
	const relations = extract.collections.reduce((n, c) => n + c.relations.length, 0);
	p.log.success(`${src.apiName}: ${extract.collections.length} collections, ${relations} relation fields → ${path}`);
	written.push(path);

	const external = new Set(extract.collections.flatMap((c) => c.relations.filter((r) => r.target.source !== src.apiName).map((r) => r.target.source)));
	const missing = [...external].filter((x) => !picked.some((q) => q.apiName === x));
	if (missing.length) p.log.warn(`${src.apiName} has relations to ${missing.join(', ')}, which you didn't extract. Those relations will be skipped on apply.`);
}

p.outro(written.length ? `Done. Apply with: bun run migrate:apply` : 'Nothing written.');
process.exit(0); // clack leaves stdin open
