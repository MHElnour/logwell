// Test doubles for the persistence ports: bindFile (a DbFile over a FileGateway) and MemoryFileGateway, an in-memory
// FileGateway with fault injection.
import type { DbFile, FileGateway } from "../../src/persistence/gateway";

export function bindFile(gateway: FileGateway, path: () => string): DbFile {
	return {
		read: () => gateway.read(path()),
		async write(content, expected) {
			const p = path();
			const current = await gateway.read(p);
			if (current === null || !expected(current)) return { written: false, current };
			await gateway.write(p, content);
			return { written: true };
		},
	};
}

class WriteFault extends Error {
	constructor(message = "Injected write fault") {
		super(message);
		this.name = "WriteFault";
	}
}

/** In-memory gateway for tests. Faults simulate crashes and partial writes. */
export class MemoryFileGateway implements FileGateway {
	readonly files = new Map<string, string>();
	/** Paths written, in order. */
	readonly writes: string[] = [];
	private faults: { match: (path: string) => boolean; truncateTo: number | null }[] = [];

	/** The next write to a matching path throws; with truncateTo it first stores a prefix (a torn write). */
	failNextWrite(match: (path: string) => boolean = () => true, truncateTo: number | null = null): void {
		this.faults.push({ match, truncateTo });
	}

	private takeFault(path: string): { truncateTo: number | null } | null {
		const i = this.faults.findIndex((f) => f.match(path));
		if (i === -1) return null;
		const [fault] = this.faults.splice(i, 1);
		return fault ?? null;
	}

	async read(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}

	async write(path: string, data: string): Promise<void> {
		const fault = this.takeFault(path);
		if (fault !== null) {
			if (fault.truncateTo !== null) this.files.set(path, data.slice(0, fault.truncateTo));
			throw new WriteFault();
		}
		this.files.set(path, data);
		this.writes.push(path);
	}

	async append(path: string, data: string): Promise<void> {
		const fault = this.takeFault(path);
		if (fault !== null) throw new WriteFault();
		this.files.set(path, (this.files.get(path) ?? "") + data);
	}

	async exists(path: string): Promise<boolean> {
		return this.files.has(path);
	}

	async list(dir: string): Promise<string[]> {
		const prefix = `${dir.replace(/\/+$/, "")}/`;
		return [...this.files.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")).sort();
	}

	async remove(path: string): Promise<void> {
		this.files.delete(path);
	}

	async mkdir(_path: string): Promise<void> {
		// Folders are implicit in the in-memory store.
	}
}
