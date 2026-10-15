// @ts-check

export class ToubaRuntimeError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ToubaRuntimeError";
    /** @type {string} */
    this.code = code;
    /** @type {Record<string, unknown>} */
    this.details = details;
  }
}

export class RuntimeStop extends ToubaRuntimeError {
  /**
   * @param {string} [message]
   * @param {Record<string, unknown>} [details]
   */
  constructor(message = "execution stopped", details = {}) {
    super("RuntimeStopped", message, { reason: "explicit_stop", ...details });
  }
}

export class RuntimeCancelled extends ToubaRuntimeError {
  /**
   * @param {string} [message]
   * @param {Record<string, unknown>} [details]
   */
  constructor(message = "execution cancelled", details = {}) {
    super("RuntimeCancelled", message, details);
  }
}

export class RuntimeFailure extends ToubaRuntimeError {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   * @param {string} [code]
   */
  constructor(message, details = {}, code = "RuntimeFailure") {
    super(code, message, details);
  }
}
