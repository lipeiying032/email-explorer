import type { Env } from "./types";

function jlog(action: string, meta: Record<string, unknown> = {}) {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			action,
			...meta,
		}),
	);
}

function createLoggedStub(stub: any, mailboxId: string, source: string) {
	return new Proxy(stub, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;

			return async (...args: unknown[]) => {
				const method = String(prop);
				jlog("mailbox.remote.call.start", {
					source,
					mailboxId,
					method,
					argCount: args.length,
				});
				try {
					const result = await value.apply(target, args);
					jlog("mailbox.remote.call.done", { source, mailboxId, method });
					return result;
				} catch (error) {
					jlog("mailbox.remote.call.error", {
						source,
						mailboxId,
						method,
						error: error instanceof Error ? error.message : String(error),
					});
					throw error;
				}
			};
		},
	});
}

export function getMailboxStub(env: Env, mailboxId: string, source: string) {
	jlog("mailbox.remote.resolve.start", { source, mailboxId });
	const doId = env.MAILBOX.idFromName(mailboxId);
	const stub = env.MAILBOX.get(doId);
	jlog("mailbox.remote.resolve.done", {
		source,
		mailboxId,
		doId: doId.toString(),
	});
	return createLoggedStub(stub, mailboxId, source);
}

export function getAuthStub(env: Env, source: string) {
	return getMailboxStub(env, "AUTH", source);
}
