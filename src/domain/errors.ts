export type DomainErrorCode =
	| "TitleRequired"
	| "InboxProtected"
	| "SubtaskDepth"
	| "SubtaskCategory"
	| "DuplicateCategoryName"
	| "DuplicateName"
	| "CategoryNameRequired"
	| "InvalidTag"
	| "NotFound"
	| "InvalidValue"
	| "ReadOnly"
	| "UndoConflict"
	| "StalePreview"
	/** The list is synced with TickTick and has 999 open tasks. */
	| "SyncedListFull";

/** An expected, user-facing rule violation. The message is shown as-is. */
export class DomainError extends Error {
	readonly code: DomainErrorCode;

	constructor(code: DomainErrorCode, message: string) {
		super(message);
		this.name = "DomainError";
		this.code = code;
	}
}

export function isDomainError(err: unknown, code?: DomainErrorCode): err is DomainError {
	return err instanceof DomainError && (code === undefined || err.code === code);
}

/** Refuses a value with `message`. */
export function invalidValue(message: string): never {
	throw new DomainError("InvalidValue", message);
}
