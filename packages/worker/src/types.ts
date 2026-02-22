export interface WorkerTask {
    id?: string;
    source?: string;
    prompt?: string;
    [key: string]: any;
}

export type WorkerResponse = {
    id?: string;
} & (
        | { status: "success"; response: string }
        | { status: "error"; error: string }
        | { status: "progress"; event: "llm_start" | "llm_end" | "tool_start" | "tool_end"; data?: any }
    );

export interface WorkerControlSignal {
    id?: string;
    command: "stop" | "steer" | "reset";
    message?: string;
}
