import { contentJson, OpenAPIRoute } from "chanfana";
import type { Context } from "hono";
import { z } from "zod";
import { getAuthStub } from "../mailbox-client";
import type { Env, Session } from "../types";

type AppContext = Context<{ Bindings: Env; Variables: { session?: Session } }>;

// Schemas
const RegisterRequestSchema = z.object({
	email: z.string().email(),
	password: z.string().min(8),
});

const LoginRequestSchema = z.object({
	email: z.string().email(),
	password: z.string(),
});

const SessionResponseSchema = z.object({
	id: z.string(),
	userId: z.string(),
	email: z.string(),
	isAdmin: z.boolean(),
	expiresAt: z.number(),
});

const UserResponseSchema = z.object({
	id: z.string(),
	email: z.string(),
	isAdmin: z.boolean(),
	createdAt: z.number(),
	updatedAt: z.number(),
});

const ErrorResponseSchema = z.object({
	error: z.string(),
});

const SuccessResponseSchema = z.object({
	status: z.string(),
});

const GrantAccessRequestSchema = z.object({
	userId: z.string(),
	mailboxId: z.string(),
	role: z.enum(["owner", "admin", "write", "read"]),
});

const RevokeAccessRequestSchema = z.object({
	userId: z.string(),
	mailboxId: z.string(),
});

const UpdateUserRequestSchema = z.object({
	isAdmin: z.boolean().optional(),
	password: z.string().min(5).optional(),
});

// Helper function to extract session token
function getSessionToken(c: AppContext): string | null {
	// Try Authorization header first
	const authHeader = c.req.header("Authorization");
	if (authHeader?.startsWith("Bearer ")) {
		return authHeader.substring(7);
	}

	// Try cookie
	const cookie = c.req.header("Cookie");
	if (cookie) {
		const match = cookie.match(/session=([^;]+)/);
		return match ? match[1] : null;
	}

	return null;
}

// Public routes
export class PostRegister extends OpenAPIRoute {
	schema = {
		summary: "Register a new user",
		operationId: "register",
		tags: ["Auth"],
		request: {
			body: contentJson(RegisterRequestSchema),
		},
		responses: {
			"201": {
				description: "User registered successfully",
				...contentJson(UserResponseSchema),
			},
			"400": {
				description: "Bad request",
				...contentJson(ErrorResponseSchema),
			},
			"403": {
				description: "Registration disabled",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { email, password } = data.body;

		const authDO = getAuthStub(c.env, "routes.auth.PostRegister");
		const registerEnabled = c.env.config?.auth?.registerEnabled;

		// Check registration eligibility
		if (registerEnabled === false) {
			return c.json({ error: "Registration is disabled" }, 403);
		}

		// Smart mode: Allow first user only
		if (registerEnabled === undefined) {
			const hasUsers = await authDO.hasUsers();
			if (hasUsers) {
				return c.json(
					{
						error: "Registration is closed. Contact an administrator.",
					},
					403,
				);
			}
		}

		try {
			// Check if this is the first user
			const isFirstUser = !(await authDO.hasUsers());
			const user = await authDO.register(email, password, isFirstUser);
			return c.json(user, 201);
		} catch (error: any) {
			if (error.message?.includes("UNIQUE constraint failed")) {
				return c.json({ error: "Email already registered" }, 400);
			}
			return c.json({ error: "Registration failed" }, 400);
		}
	}
}

export class PostLogin extends OpenAPIRoute {
	schema = {
		summary: "Login",
		operationId: "login",
		tags: ["Auth"],
		request: {
			body: contentJson(LoginRequestSchema),
		},
		responses: {
			"200": {
				description: "Login successful",
				...contentJson(SessionResponseSchema),
			},
			"401": {
				description: "Unauthorized",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { email, password } = data.body;

		const authDO = getAuthStub(c.env, "routes.auth.PostRegister");
		const session = await authDO.login(email, password);

		if (!session) {
			return c.json({ error: "Invalid credentials" }, 401);
		}

		// Set cookie
		const cookie = `session=${session.id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 60 * 60}`;
		c.header("Set-Cookie", cookie);

		return c.json(session);
	}
}

export class PostLogout extends OpenAPIRoute {
	schema = {
		summary: "Logout",
		operationId: "logout",
		tags: ["Auth"],
		responses: {
			"200": {
				description: "Logout successful",
				...contentJson(SuccessResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const sessionToken = getSessionToken(c);
		if (sessionToken) {
			const authDO = getAuthStub(c.env, "routes.auth.PostRegister");
			await authDO.logout(sessionToken);
		}

		// Clear cookie
		c.header(
			"Set-Cookie",
			"session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
		);

		return c.json({ status: "logged out" });
	}
}

export class GetMe extends OpenAPIRoute {
	schema = {
		summary: "Get current user",
		operationId: "getCurrentUser",
		tags: ["Auth"],
		responses: {
			"200": {
				description: "Current user session",
				...contentJson(SessionResponseSchema),
			},
			"401": {
				description: "Unauthorized",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const session = c.get("session");
		if (!session) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		return c.json(session);
	}
}

// Admin routes
export class PostAdminRegister extends OpenAPIRoute {
	schema = {
		summary: "Register a new user (admin only)",
		operationId: "adminRegister",
		tags: ["Auth - Admin"],
		request: {
			body: contentJson(RegisterRequestSchema),
		},
		responses: {
			"201": {
				description: "User registered successfully",
				...contentJson(UserResponseSchema),
			},
			"400": {
				description: "Bad request",
				...contentJson(ErrorResponseSchema),
			},
			"401": {
				description: "Unauthorized",
				...contentJson(ErrorResponseSchema),
			},
			"403": {
				description: "Forbidden - Admin privileges required",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const session = c.get("session");
		if (!session) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		if (!session.isAdmin) {
			return c.json({ error: "Admin privileges required" }, 403);
		}

		const data = await this.getValidatedData<typeof this.schema>();
		const { email, password } = data.body;

		const authDO = getAuthStub(c.env, "routes.auth.PostRegister");

		try {
			const user = await authDO.register(email, password, false);
			return c.json(user, 201);
		} catch (error: any) {
			if (error.message?.includes("UNIQUE constraint failed")) {
				return c.json({ error: "Email already registered" }, 400);
			}
			return c.json({ error: "Registration failed" }, 400);
		}
	}
}

export class GetUsers extends OpenAPIRoute {
	schema = {
		summary: "Get all users (admin only)",
		operationId: "getUsers",
		tags: ["Auth - Admin"],
		responses: {
			"200": {
				description: "List of users",
				...contentJson(z.array(UserResponseSchema)),
			},
			"401": {
				description: "Unauthorized",
				...contentJson(ErrorResponseSchema),
			},
			"403": {
				description: "Forbidden - Admin privileges required",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const session = c.get("session");
		if (!session) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		if (!session.isAdmin) {
			return c.json({ error: "Admin privileges required" }, 403);
		}

		const authDO = getAuthStub(c.env, "routes.auth.PostRegister");
		const users = await authDO.getUsers();

		return c.json(users);
	}
}

export class PutUser extends OpenAPIRoute {
	schema = {
		summary: "Update a user (admin only)",
		operationId: "updateUser",
		tags: ["Auth - Admin"],
		request: {
			params: z.object({
				userId: z.string(),
			}),
			body: contentJson(UpdateUserRequestSchema),
		},
		responses: {
			"200": {
				description: "User updated successfully",
				...contentJson(SuccessResponseSchema),
			},
			"401": {
				description: "Unauthorized",
				...contentJson(ErrorResponseSchema),
			},
			"403": {
				description: "Forbidden - Admin privileges required",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const session = c.get("session");
		if (!session) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		if (!session.isAdmin) {
			return c.json({ error: "Admin privileges required" }, 403);
		}

		const data = await this.getValidatedData<typeof this.schema>();
		const { userId } = data.params;

		const authDO = getAuthStub(c.env, "routes.auth.PostRegister");

		if (data.body.password !== undefined) {
			await authDO.updateUserPassword(userId, data.body.password);
		}

		if (data.body.isAdmin !== undefined) {
			await authDO.updateUserAdminStatus(userId, data.body.isAdmin);
		}

		return c.json({ status: "updated" });
	}
}

export class PostGrantAccess extends OpenAPIRoute {
	schema = {
		summary: "Grant mailbox access to a user (admin only)",
		operationId: "grantMailboxAccess",
		tags: ["Auth - Admin"],
		request: {
			body: contentJson(GrantAccessRequestSchema),
		},
		responses: {
			"200": {
				description: "Access granted successfully",
				...contentJson(SuccessResponseSchema),
			},
			"401": {
				description: "Unauthorized",
				...contentJson(ErrorResponseSchema),
			},
			"403": {
				description: "Forbidden - Admin privileges required",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const session = c.get("session");
		if (!session) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		if (!session.isAdmin) {
			return c.json({ error: "Admin privileges required" }, 403);
		}

		const data = await this.getValidatedData<typeof this.schema>();
		const { userId, mailboxId, role } = data.body;

		const authDO = getAuthStub(c.env, "routes.auth.PostRegister");
		await authDO.grantMailboxAccess(userId, mailboxId, role);

		return c.json({ status: "access granted" });
	}
}

export class PostRevokeAccess extends OpenAPIRoute {
	schema = {
		summary: "Revoke mailbox access from a user (admin only)",
		operationId: "revokeMailboxAccess",
		tags: ["Auth - Admin"],
		request: {
			body: contentJson(RevokeAccessRequestSchema),
		},
		responses: {
			"200": {
				description: "Access revoked successfully",
				...contentJson(SuccessResponseSchema),
			},
			"401": {
				description: "Unauthorized",
				...contentJson(ErrorResponseSchema),
			},
			"403": {
				description: "Forbidden - Admin privileges required",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const session = c.get("session");
		if (!session) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		if (!session.isAdmin) {
			return c.json({ error: "Admin privileges required" }, 403);
		}

		const data = await this.getValidatedData<typeof this.schema>();
		const { userId, mailboxId } = data.body;

		const authDO = getAuthStub(c.env, "routes.auth.PostRegister");
		await authDO.revokeMailboxAccess(userId, mailboxId);

		return c.json({ status: "access revoked" });
	}
}
