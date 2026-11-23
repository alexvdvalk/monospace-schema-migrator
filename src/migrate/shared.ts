// Shared pieces of the data-model migration scripts (extract.ts / apply.ts):
// prompts for connecting to an instance, the HTTP helper, the schema-manifest decoder and the
// extract file format.
import * as p from '@clack/prompts';

// ---------------------------------------------------------------------------------------------
// Prompts

/** Unwraps a prompt result, exiting cleanly on Ctrl-C / Esc. */
export function answer<T>(value: T): Exclude<T, symbol> {
	if (p.isCancel(value)) {
		p.cancel('Cancelled.');
		process.exit(0);
	}
	return value as Exclude<T, symbol>;
}

export type Conn = { host: string; workspace: string; base: string; headers: Record<string, string> };
export type Source = { id: string; apiName: string; provider: string };

const SYSTEM_SOURCE_ID = '00000000-0000-0000-0000-000000000000';

/** Prompts for an instance URL + token, lists its workspaces and lets the user pick one. */
export async function connect(role: string, defaultUrl: string): Promise<Conn> {
	const url = answer(
		await p.text({
			message: `${role} Monospace URL`,
			placeholder: defaultUrl,
			defaultValue: defaultUrl,
			validate: (v) => (!v || /^https?:\/\/[^/]+\/?$/.test(v) ? undefined : 'Expected e.g. https://example.monospace.io'),
		}),
	);
	const host = url.replace(/\/$/, '');
	const token = answer(await p.password({ message: `${role} API token`, validate: (v) => (v ? undefined : 'Required') }));
	const headers = { Authorization: `Bearer ${token.trim()}`, 'Content-Type': 'application/json' };

	const s = p.spinner();
	s.start('Fetching workspaces');
	let workspaces: { apiName: string; displayName?: string }[];
	try {
		workspaces = (await request({ host, workspace: '', base: `${host}/api`, headers }, 'GET', '/system/workspaces?fields=apiName,displayName&limit=-1')).data;
		s.stop(`Found ${workspaces.length} workspace(s)`);
	} catch (e) {
		s.error('Could not list workspaces');
		p.log.error((e as Error).message);
		process.exit(1);
	}
	if (!workspaces.length) {
		p.log.error('This token cannot see any workspaces.');
		process.exit(1);
	}

	const workspace = answer(
		await p.select({
			message: `${role} workspace`,
			options: workspaces.map((w) => ({ value: w.apiName, label: w.displayName ?? w.apiName, hint: w.apiName })),
		}),
	);
	return { host, workspace, base: `${host}/api/${workspace}`, headers };
}

/** Awaits a step; on failure prints a readable error (403s explained) and exits. */
export async function orExit<T>(promise: Promise<T>, what: string, conn: Conn): Promise<T> {
	try {
		return await promise;
	} catch (e) {
		const msg = (e as Error).message;
		p.log.error(`Could not ${what} in workspace "${conn.workspace}".\n${msg}`);
		if (/→ 40[13] /.test(msg)) p.log.info('The token has no access to this workspace\'s schema. Use a token with the dataModel:read / dataSource:read permissions (and dataModel:edit to apply).');
		process.exit(1);
	}
}

export async function request(conn: Conn, method: string, path: string, body?: unknown) {
	const res = await fetch(conn.base + path, { method, headers: conn.headers, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${conn.base}${path} → ${res.status} ${text}`);
	return text ? JSON.parse(text) : undefined;
}

/** The workspace's data sources (the built-in system database excluded). */
export async function listSources(conn: Conn): Promise<Source[]> {
	const { data } = await request(conn, 'GET', '/schema/structure/sources?fields=id,apiName,provider&limit=-1');
	return (data as Source[]).filter((s) => s.id !== SYSTEM_SOURCE_ID).sort((a, b) => a.apiName.localeCompare(b.apiName));
}

// ---------------------------------------------------------------------------------------------
// Data model

export type PrimitiveType = { name: string; params?: unknown };
export type Field = { apiName: string; dbName: string; type: PrimitiveType; isNullable: boolean; isList: boolean; defaultValue?: unknown };
export type Index = { dbName: string; kind: 'primary' | 'unique' | 'normal'; fields: string[] /* field apiNames */ };
export type Relation = {
	apiName: string;
	target: { source: string; collection: string }; // source + collection apiName
	oppositeField: string; // relation field apiName on the target
	isList: boolean;
	isForward: boolean;
	linking: { local: string; target: string }[]; // primitive field apiNames
	constraint?: { dbName: string; onDelete?: string; onUpdate?: string };
};
export type Collection = { apiName: string; dbName: string; fields: Field[]; indexes: Index[]; relations: Relation[] };

/** A decoded collection plus the ids the instance gave it (needed when writing relations). */
export type LiveCollection = Collection & { id: string; source: string; isSystem: boolean; fieldIds: Map<string, string> };

/** Decodes the workspace's compact schema manifest (GET /schema, formatVersion 1). */
export async function readModel(conn: Conn): Promise<Map<string, LiveCollection>> {
	const doc = await request(conn, 'GET', '/schema');
	if (doc.formatVersion !== 1) throw new Error(`Unsupported schema manifest formatVersion ${doc.formatVersion}`);
	const str = (i: number): string => doc.strings[i];
	const types: PrimitiveType[] = doc.primitiveTypes;
	const raw = doc.monospaceSchema;
	const sourceName: string[] = raw.sources.map((s: any) => str(s.name));

	const out = new Map<string, LiveCollection>();
	for (const c of raw.collections) {
		const pf = c.primitiveFields as any[];
		out.set(str(c.apiName), {
			id: c.id,
			apiName: str(c.apiName),
			dbName: str(c.dbName ?? c.apiName),
			source: sourceName[c.source]!,
			isSystem: c.isSystem ?? false,
			fieldIds: new Map(pf.map((f) => [str(f.apiName), f.id])),
			fields: pf.map((f) => ({
				apiName: str(f.apiName),
				dbName: str(f.dbName ?? f.apiName),
				type: types[f.type]!,
				isNullable: f.isNullable ?? false,
				isList: f.isList ?? false,
				...(f.defaultValue === undefined ? {} : { defaultValue: f.defaultValue }),
			})),
			indexes: (c.indexes ?? []).map((ix: any) => ({ dbName: str(ix.dbName), kind: ix.kind, fields: ix.fields.map((i: number) => str(pf[i].apiName)) })),
			relations: (c.relationFields as any[]).map((r) => {
				const t = raw.collections[r.oppositeCollection];
				return {
					apiName: str(r.apiName),
					target: { source: sourceName[t.source]!, collection: str(t.apiName) },
					oppositeField: str(t.relationFields[r.oppositeField].apiName),
					isList: r.isList ?? false,
					isForward: r.isForward ?? false,
					linking: r.linkingFields.map(([l, o]: [number, number]) => ({ local: str(pf[l].apiName), target: str(t.primitiveFields[o].apiName) })),
					...(r.constraint ? { constraint: { dbName: str(r.constraint.dbName), onDelete: r.constraint.onDelete, onUpdate: r.constraint.onUpdate } } : {}),
				};
			}),
		});
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// Extract file format: one JSON file per data source.

export type ExtractFile = {
	formatVersion: 1;
	extractedAt: string;
	origin: { url: string; workspace: string; source: { apiName: string; provider: string } };
	collections: Collection[];
};

export function toExtract(conn: Conn, source: Source, model: Map<string, LiveCollection>): ExtractFile {
	const collections = [...model.values()]
		.filter((c) => !c.isSystem && c.source === source.apiName)
		.sort((a, b) => a.apiName.localeCompare(b.apiName))
		.map(({ apiName, dbName, fields, indexes, relations }) => ({ apiName, dbName, fields, indexes, relations }));
	return {
		formatVersion: 1,
		extractedAt: new Date().toISOString(),
		origin: { url: conn.host, workspace: conn.workspace, source: { apiName: source.apiName, provider: source.provider } },
		collections,
	};
}
