/**
 * @nasdigital/mcp-server-core
 *
 * The shared spine for a family of Model Context Protocol servers: a fetch
 * layer that cannot hang or leak, a pluggable authorization interface that
 * permits everything by default, error sanitisation, one dispatch choke point,
 * and machine-checkable API coverage.
 *
 * It exists because the servers it was extracted from had copied the same
 * three modules byte-for-byte nine times, and the copies had drifted.
 */

export {
  HttpClient,
  HttpError,
  HttpTimeoutError,
  type HttpClientOptions,
  type RequestOptions,
} from "./http.js";

export {
  allowAll,
  readOnly,
  noDestructive,
  combine,
  authorizerFromEnv,
  AuthorizationError,
  type Authorizer,
  type AuthorizationRequest,
} from "./authorize.js";

export { ToolError, toSafeMessage, errorResult, okResult } from "./errors.js";

export { createServer, runServer, type ToolDefinition, type ServerOptions } from "./server.js";

export {
  checkCoverage,
  formatCoverage,
  operationsFromOpenApi,
  type Operation,
  type OperationStatus,
  type CoverageReport,
} from "./coverage.js";

export { Dispatcher, type DispatchableOperation } from "./dispatch.js";

export { requireEnv, optionalEnv, pageSize, pageNumber, httpUrl, boundedText } from "./validate.js";
