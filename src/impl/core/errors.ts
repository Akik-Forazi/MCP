/**
 * AXONIZ-ZERO Error Hierarchy
 * Production-grade typed errors for clear error handling throughout the system.
 */

export interface ErrorDetails {
  [key: string]: unknown;
}

/** Base class for all AXONIZ-ZERO errors. */
export class AxonizError extends Error {
  code: string;
  details: ErrorDetails;

  constructor(message: string, code = "AXONIZ_ERROR", details: ErrorDetails = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toDict(): { error: string; message: string; details: ErrorDetails } {
    return { error: this.code, message: this.message, details: this.details };
  }
}

/* ── Backend errors ───────────────────────────────────────────────────────── */

export class BackendError extends AxonizError {
  backend: string;

  constructor(message: string, backend = "", details: ErrorDetails = {}) {
    super(message, "BACKEND_ERROR", details);
    this.backend = backend;
  }
}

/** Backend server is not reachable. */
export class BackendNotAvailableError extends BackendError {
  constructor(backend: string, url = "") {
    super(`Backend '${backend}' is not available${url ? ` at ${url}` : ""}`, backend, { url });
    this.code = "BACKEND_NOT_AVAILABLE";
  }
}

/** Requested model does not exist on the backend. */
export class ModelNotFoundError extends BackendError {
  constructor(model: string, backend = "") {
    super(`Model '${model}' not found`, backend, { model });
    this.code = "MODEL_NOT_FOUND";
  }
}

/** API key is required but not configured. */
export class ApiKeyMissingError extends BackendError {
  constructor(backend: string) {
    super(`API key not set for '${backend}'`, backend);
    this.code = "API_KEY_MISSING";
  }
}

/** Backend did not respond within the allowed time. */
export class BackendTimeoutError extends BackendError {
  constructor(backend: string, timeout: number) {
    super(
      `Backend '${backend}' timed out after ${timeout.toFixed(1)}s`,
      backend,
      { timeout },
    );
    this.code = "BACKEND_TIMEOUT";
  }
}

/** API rate limit was hit. */
export class RateLimitError extends BackendError {
  constructor(backend: string, retryAfter = 0) {
    super(
      `Rate limit hit on '${backend}'${retryAfter ? `, retry after ${retryAfter}s` : ""}`,
      backend,
      { retry_after: retryAfter },
    );
    this.code = "RATE_LIMIT";
  }
}

/* ── Tool errors ──────────────────────────────────────────────────────────── */

export class ToolError extends AxonizError {
  tool: string;

  constructor(message: string, tool = "", details: ErrorDetails = {}) {
    super(message, "TOOL_ERROR", details);
    this.tool = tool;
  }
}

/** Tool exceeded its time budget. */
export class ToolTimeoutError extends ToolError {
  constructor(tool: string, timeout: number) {
    super(`Tool '${tool}' timed out after ${timeout.toFixed(1)}s`, tool, { timeout });
    this.code = "TOOL_TIMEOUT";
  }
}

/** Tool attempted a disallowed operation. */
export class ToolSecurityError extends ToolError {
  constructor(tool: string, reason: string) {
    super(`Security violation in '${tool}': ${reason}`, tool, { reason });
    this.code = "TOOL_SECURITY";
  }
}

/** File operation attempted outside the allowed workspace. */
export class WorkspaceViolationError extends ToolError {
  constructor(path: string, workspace: string) {
    super(
      `Path '${path}' is outside the workspace '${workspace}'`,
      "file",
      { path, workspace },
    );
    this.code = "WORKSPACE_VIOLATION";
  }
}

/** File size exceeds the allowed limit. */
export class FileTooLargeError extends ToolError {
  constructor(path: string, size: number, limit: number) {
    super(
      `File '${path}' is ${size.toLocaleString()} bytes, limit is ${limit.toLocaleString()} bytes`,
      "file",
      { path, size, limit },
    );
    this.code = "FILE_TOO_LARGE";
  }
}

/* ── Agent errors ─────────────────────────────────────────────────────────── */

export class AgentError extends AxonizError {
  constructor(message: string, details: ErrorDetails = {}) {
    super(message, "AGENT_ERROR", details);
  }
}

/** Agent detected an infinite loop. */
export class AgentLoopError extends AgentError {
  constructor(tool: string, count: number) {
    super(`Infinite loop: '${tool}' called ${count} times with identical args`, {
      tool,
      count,
    });
    this.code = "AGENT_LOOP";
  }
}

/** Agent exhausted its step budget. */
export class AgentMaxStepsError extends AgentError {
  constructor(steps: number) {
    super(`Exhausted maximum ${steps} steps`, { steps });
    this.code = "AGENT_MAX_STEPS";
  }
}

/* ── Config errors ────────────────────────────────────────────────────────── */

export class ConfigError extends AxonizError {
  constructor(message: string, key = "") {
    super(message, "CONFIG_ERROR", { key });
  }
}

/* ── Network errors ───────────────────────────────────────────────────────── */

export class NetworkError extends AxonizError {
  constructor(message: string, url = "") {
    super(message, "NETWORK_ERROR", { url });
  }
}
