export interface WorkerTask {
	task_id?: string;
	receiver?: string; // STACK-RS-310: renamed from user_id
	submitter?: string; // STACK-RS-310: new field
	source?: string;
	prompt?: string;
	session_id?: string;
	images?: string[]; // Relative paths to images in workspace (e.g. ".console/abc.jpg")
	[key: string]: any;
}

export type WorkerResponse = {
	task_id?: string;
	receiver?: string; // STACK-RS-310
	submitter?: string; // STACK-RS-310
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
	task_id?: string;
	receiver?: string; // STACK-RS-310
	source?: string;
	command: "stop" | "steer" | "reset";
	message?: string;
}
