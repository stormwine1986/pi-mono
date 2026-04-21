export interface WorkerTask {
	id?: string;
	user_id?: string;
	source?: string;
	prompt?: string;
	session_id?: string;
	images?: string[]; // Relative paths to images in workspace (e.g. ".console/abc.jpg")
	[key: string]: any;
}

export type WorkerResponse = {
	id?: string;
	user_id?: string;
	source?: string;
	agent_id?: string;
	session_id?: string;
} & (
	| {
			status: "success";
			response: string;
			images?: string[];
			usage?: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
				totalTokens: number;
				cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
			};
	  }
	| { status: "error"; error: string }
	| { status: "aborted"; error: string }
	| { status: "progress"; event: string; data?: any }
);

export interface WorkerControlSignal {
	id?: string;
	user_id?: string;
	source?: string;
	command: "stop" | "steer" | "reset";
	message?: string;
}
