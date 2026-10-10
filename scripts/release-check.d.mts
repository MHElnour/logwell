export const ALLOWED_HEADINGS: string[];
export const PATCH_HEADINGS: string[];
export const RELEASES_DIR: string;
export const UNRELEASED_FILE: string;
export const INDEX_FILE: string;
export const EMPTY_UNRELEASED: string;
export class ReleaseError extends Error {}
export type Bump = "patch" | "minor" | "major";
export interface NotesGroup {
	heading: string;
	bullets: number;
	lines: string[];
}
export function stripComments(text: string): string;
export function parseGroups(text: string): { groups: NotesGroup[]; stray: number };
export function bumpType(oldV: string, newV: string): Bump | null;
export function resolveBump(arg: string | undefined, env: Record<string, string | undefined>, currentVersion: string): Bump | null;
export function preCheck(unreleased: string, bump: Bump | null): { bump: Bump | null; headings: string[] };
export function lintUnreleased(unreleased: string): void;
export function renderEntries(unreleased: string): string;
export function renderRelease(version: string, date: string, entries: string): string;
export function parseRelease(text: string): { version: string; date: string; body: string } | null;
export function buildIndex(releases: { version: string; date: string }[]): string;
export function readReleases(root: string): { version: string; date: string }[];
export function writeIndex(root: string): void;
export function versionStage(root: string, version: string, opts?: { date?: string; git?: boolean }): void;
export function verify(root: string, tag: string): string;
export function lintReleases(root: string): void;
export function main(argv: string[], env: Record<string, string | undefined>, root: string): void;
