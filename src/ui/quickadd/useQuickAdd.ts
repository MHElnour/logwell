import { useEffect, useReducer, useRef } from "preact/hooks";
import { type QuickAddEnv, QuickAddModel } from "./QuickAddModel";

/** One controller per mounted form or add bar. `env` may change between renders (the view's preset). */
export function useQuickAdd(env: QuickAddEnv): QuickAddModel {
	const [, force] = useReducer((n: number) => n + 1, 0);
	const rerender = () => force(0);
	const ref = useRef<QuickAddModel | null>(null);
	if (ref.current === null) ref.current = new QuickAddModel(env, rerender);
	const model = ref.current;
	model.env = env;
	useEffect(() => {
		const off = env.app.store.bus.on("changed", () => model.refresh());
		return () => {
			off();
			model.dispose();
		};
	}, [model, env.app]);
	return model;
}
