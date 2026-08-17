/**
 * The Egma model gateway, as a module.
 *
 * The deployed entry point is `worker.ts` and the local one is
 * `host/node.ts`; this is what a test and a reader reach for.
 */

export {
  type Config,
  ConfigurationFault,
  type Environment,
  loadConfig,
  MODEL_JOBS,
  type ModelJob,
  OPTIONAL_NAMES,
  PROVIDER_HOME,
  type Provider,
  PROVIDERS,
  REQUIRED_NAMES,
  SECRET_NAMES,
} from "./config.ts";
export { type GatewayHost, handle } from "./gateway.ts";
export {
  type Log,
  makeLog,
  type OperationalRecord,
  operationalRecord,
  RECORD_FIELDS,
  type RecordField,
  STATUS_CLASSES,
  type StatusClass,
} from "./record.ts";
export { newRequestId } from "./request-id.ts";
export { HEALTH_PATH, matchRoute, type Route, ROUTES, type Transport } from "./routes.ts";
export { type Duplex, type SocketHost, UpstreamHandshakeRefused } from "./socket.ts";
export {
  type Authenticated,
  isAuthenticated,
  staticSecretVerifier,
  type Verified,
  type Verifier,
} from "./verify.ts";
export { AUTHENTICATION_HEADER, AUTHENTICATION_PARAMETER } from "./wire.ts";
