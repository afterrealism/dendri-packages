import Logger, { LogLevel } from "../src/logger";

describe("Logger _print", () => {
	let originalPrint: any;

	beforeEach(() => {
		// Save original _print
		//@ts-expect-error accessing private member
		originalPrint = Logger._print;
	});

	afterEach(() => {
		// Restore original _print
		Logger.setLogFunction(originalPrint);
		Logger.logLevel = LogLevel.Disabled;
	});

	describe("default _print function", () => {
		it("should call console.log for LogLevel.All", () => {
			// Restore original _print (not the spy from other tests)
			Logger.setLogFunction(originalPrint);
			Logger.logLevel = LogLevel.All;

			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			Logger.log("test message");

			expect(consoleSpy).toHaveBeenCalledWith("Dendri: ", "test message");
			consoleSpy.mockRestore();
		});

		it("should call console.warn with WARNING prefix for LogLevel.Warnings", () => {
			Logger.setLogFunction(originalPrint);
			Logger.logLevel = LogLevel.All;

			const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			Logger.warn("warning message");

			expect(consoleSpy).toHaveBeenCalledWith("WARNING", "Dendri: ", "warning message");
			consoleSpy.mockRestore();
		});

		it("should call console.error with ERROR prefix for LogLevel.Errors", () => {
			Logger.setLogFunction(originalPrint);
			Logger.logLevel = LogLevel.All;

			const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			Logger.error("error message");

			expect(consoleSpy).toHaveBeenCalledWith("ERROR", "Dendri: ", "error message");
			consoleSpy.mockRestore();
		});

		it("should format Error objects as (name) message", () => {
			Logger.setLogFunction(originalPrint);
			Logger.logLevel = LogLevel.All;

			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			const testError = new Error("something failed");
			Logger.log("context:", testError);

			expect(consoleSpy).toHaveBeenCalledWith("Dendri: ", "context:", "(Error) something failed");
			consoleSpy.mockRestore();
		});

		it("should format custom Error subtypes correctly", () => {
			Logger.setLogFunction(originalPrint);
			Logger.logLevel = LogLevel.All;

			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			const testError = new TypeError("type mismatch");
			Logger.log(testError);

			expect(consoleSpy).toHaveBeenCalledWith("Dendri: ", "(TypeError) type mismatch");
			consoleSpy.mockRestore();
		});
	});

	describe("log level filtering with _print", () => {
		it("should not log when level is Disabled", () => {
			Logger.setLogFunction(originalPrint);
			Logger.logLevel = LogLevel.Disabled;

			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			Logger.log("should not appear");
			Logger.warn("should not appear");
			Logger.error("should not appear");

			expect(logSpy).not.toHaveBeenCalled();
			expect(warnSpy).not.toHaveBeenCalled();
			expect(errorSpy).not.toHaveBeenCalled();

			logSpy.mockRestore();
			warnSpy.mockRestore();
			errorSpy.mockRestore();
		});

		it("should only log errors when level is Errors", () => {
			Logger.setLogFunction(originalPrint);
			Logger.logLevel = LogLevel.Errors;

			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			Logger.log("should not appear");
			Logger.warn("should not appear");
			Logger.error("should appear");

			expect(logSpy).not.toHaveBeenCalled();
			expect(warnSpy).not.toHaveBeenCalled();
			expect(errorSpy).toHaveBeenCalledTimes(1);

			logSpy.mockRestore();
			warnSpy.mockRestore();
			errorSpy.mockRestore();
		});

		it("should log errors and warnings when level is Warnings", () => {
			Logger.setLogFunction(originalPrint);
			Logger.logLevel = LogLevel.Warnings;

			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			Logger.log("should not appear");
			Logger.warn("should appear");
			Logger.error("should appear");

			expect(logSpy).not.toHaveBeenCalled();
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(errorSpy).toHaveBeenCalledTimes(1);

			logSpy.mockRestore();
			warnSpy.mockRestore();
			errorSpy.mockRestore();
		});
	});
});
