// A desktop notification while the app runs. The permission is asked on a user gesture (a set starting),
// never from a timer callback, and not again once the user has answered.

export interface NotificationApiLike {
	readonly permission: string;
	requestPermission(): Promise<string>;
	/** `onClick` runs when the user clicks the notification (a habit reminder opens the Habits page). */
	create(title: string, body: string, onClick?: () => void): void;
}

interface NotifierEnv {
	/** Null where the platform has no notifications. */
	api: NotificationApiLike | null;
	/** True while the Obsidian window has focus: the Notice already shows. */
	hasFocus(): boolean;
}

export class SystemNotifier {
	private asked = false;

	constructor(private readonly env: () => NotifierEnv = defaultEnv) {}

	/** Call from a user gesture. Asks once; nothing happens when granted, denied or missing. */
	requestPermission(): void {
		const { api } = this.env();
		if (api === null || this.asked || api.permission !== "default") return;
		this.asked = true;
		try {
			void api.requestPermission().catch(() => undefined);
		} catch {
			// Not every host allows notifications; the Notice already told the user.
		}
	}

	/** Shows the notification only when permission is granted and the window is in the background. */
	notify(title: string, body: string, onClick?: () => void): void {
		const env = this.env();
		if (env.api === null || env.api.permission !== "granted" || env.hasFocus()) return;
		try {
			if (onClick === undefined) env.api.create(title, body);
			else env.api.create(title, body, onClick);
		} catch {
			// See above.
		}
	}
}

function defaultEnv(): NotifierEnv {
	if (typeof Notification === "undefined") return { api: null, hasFocus: appHasFocus };
	return {
		api: {
			get permission() {
				return Notification.permission;
			},
			requestPermission: () => Notification.requestPermission(),
			create: (title, body, onClick) => {
				const n = new Notification(title, { body });
				if (onClick === undefined) return;
				n.onclick = () => {
					// Bring Obsidian to the front first; the page opens in the active window.
					window.focus();
					onClick();
				};
			},
		},
		hasFocus: appHasFocus,
	};
}

/** True while the focused Obsidian window, the main one or a popout, is in front. */
export function appHasFocus(): boolean {
	return (typeof activeDocument === "undefined" || activeDocument === undefined ? document : activeDocument).hasFocus();
}
