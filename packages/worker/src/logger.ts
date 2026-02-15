export function log(message: string, ...args: any[]) {
	const now = new Date();
	const timestamp = `${now.toISOString().replace("T", " ").replace("Z", "")}`;
	console.log(`[${timestamp}] ${message}`, ...args);
}

export function error(message: string, ...args: any[]) {
	const now = new Date();
	const timestamp = `${now.toISOString().replace("T", " ").replace("Z", "")}`;
	console.error(`[${timestamp}] ${message}`, ...args);
}
