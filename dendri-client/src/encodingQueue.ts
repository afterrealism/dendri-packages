import { EventEmitter } from "eventemitter3";
import logger from "./logger";

export class EncodingQueue extends EventEmitter {
	private _queue: Blob[] = [];
	private _processing: boolean = false;

	get queue(): Blob[] {
		return this._queue;
	}

	get size(): number {
		return this.queue.length;
	}

	get processing(): boolean {
		return this._processing;
	}

	enqueue(blob: Blob): void {
		this.queue.push(blob);

		if (this.processing) return;

		this.doNextTask();
	}

	destroy(): void {
		this._queue = [];
	}

	private doNextTask(): void {
		if (this.size === 0) return;
		if (this.processing) return;

		this._processing = true;

		const blob = this.queue.shift()!;

		blob
			.arrayBuffer()
			.then((result) => {
				this._processing = false;
				this.emit("done", result);
				this.doNextTask();
			})
			.catch((err) => {
				logger.error(`EncodingQueue error:`, err);
				this._processing = false;
				this.destroy();
				this.emit("error", err);
			});
	}
}
