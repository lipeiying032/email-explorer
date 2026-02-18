export interface EmailExplorerOptions {
	auth?: {
		enabled?: boolean;
		registerEnabled?: boolean;
	};
	accountRecovery?: {
		fromEmail: string;
	};
}

export type Env = {
	DB: D1Database;
	BUCKET: R2Bucket;
	SEND_EMAIL: SendEmail;
	ASSETS: Fetcher;
	config?: EmailExplorerOptions;
};
