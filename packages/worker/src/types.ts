export interface EmailExplorerOptions {
	auth?: {
		enabled?: boolean;
		registerEnabled?: boolean;
	};
	accountRecovery?: {
		fromEmail: string;
	};
}

export interface Session {
	id: string;
	userId: string;
	email: string;
	isAdmin: boolean;
	expiresAt: number;
}

export interface User {
	id: string;
	email: string;
	isAdmin: boolean;
	createdAt: number;
	updatedAt: number;
}

export type Env = {
	MAILBOX: DurableObjectNamespace;
	BUCKET: R2Bucket;
	SEND_EMAIL: SendEmail;
	ASSETS: Fetcher;
	DB: D1Database;
	config?: EmailExplorerOptions;
};
