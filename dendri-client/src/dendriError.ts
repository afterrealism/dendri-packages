import { EventEmitter } from "eventemitter3";
import logger from "./logger";

export interface EventsWithError<ErrorType extends string> {
	error: (error: DendriError<`${ErrorType}`>) => void;
}

export class EventEmitterWithError<
	ErrorType extends string,
	Events extends EventsWithError<ErrorType>,
> extends EventEmitter<Events, never> {
	/**
	 * Emits a typed error message.
	 *
	 * @internal
	 */
	emitError(type: ErrorType, err: string | Error, retryable = false): void {
		logger.error("Error:", err);

		const error = new DendriError<`${ErrorType}`>(`${type}`, err);
		error.retryable = retryable;

		// @ts-expect-error
		this.emit("error", error);
	}
}
/**
 * A DendriError is emitted whenever an error occurs.
 * It always has a `.type`, which can be used to identify the error.
 */
export class DendriError<T extends string> extends Error {
	public type: T;

	/** Whether the operation that caused this error can be retried. */
	public retryable: boolean;

	/** Structured context about the error. */
	public details?: Record<string, unknown>;

	/**
	 * @internal
	 */
	constructor(type: T, err: Error | string) {
		if (typeof err === "string") {
			super(err);
		} else {
			super(err.message);
			this.stack = err.stack;
		}

		this.type = type;
		this.retryable = false;
	}

	/** Set the retryable flag (fluent API). */
	setRetryable(retryable: boolean): this {
		this.retryable = retryable;
		return this;
	}

	/** Set structured details (fluent API). */
	setDetails(details: Record<string, unknown>): this {
		this.details = details;
		return this;
	}
}
