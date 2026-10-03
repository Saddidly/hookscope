import path from "node:path";
import { isIP } from "node:net";

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

function integerSetting(value, name, fallback, minimum, maximum) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value))
    throw new ConfigError(`${name} must be a whole number.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function validateLoopbackTarget(target, index) {
  if (!target || typeof target !== "object" || Array.isArray(target))
    throw new ConfigError(`Replay target ${index + 1} must be an object.`);
  if (
    typeof target.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(target.id)
  ) {
    throw new ConfigError(
      `Replay target ${index + 1} needs an id using letters, numbers, dash, or underscore.`,
    );
  }
  if (
    typeof target.label !== "string" ||
    target.label.trim().length === 0 ||
    target.label.length > 80
  ) {
    throw new ConfigError(
      `Replay target ${target.id} needs a label of 1 to 80 characters.`,
    );
  }
  if (typeof target.url !== "string")
    throw new ConfigError(`Replay target ${target.id} needs a URL.`);
  let url;
  try {
    url = new URL(target.url);
  } catch {
    throw new ConfigError(`Replay target ${target.id} has an invalid URL.`);
  }
  const address =
    url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;
  const loopback =
    address === "::1" || (isIP(address) === 4 && address.startsWith("127."));
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !loopback ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ConfigError(
      `Replay target ${target.id} must use HTTP(S) and a literal loopback IP, without credentials, query, or fragment.`,
    );
  }
  return Object.freeze({
    id: target.id,
    label: target.label.trim(),
    url: url.toString(),
  });
}

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const host = env.HOOKSCOPE_HOST || "127.0.0.1";
  if (typeof host !== "string" || host.trim() === "")
    throw new ConfigError("HOOKSCOPE_HOST must be a host name or IP address.");
  if (!(
    host === "localhost" ||
    host === "::1" ||
    (isIP(host) === 4 && host.startsWith("127."))
  ))
    throw new ConfigError(
      "HOOKSCOPE_HOST must be a loopback address; this service has no multi-user authentication.",
    );
  const port = integerSetting(
    env.HOOKSCOPE_PORT,
    "HOOKSCOPE_PORT",
    4173,
    1,
    65535,
  );
  const maxBodyBytes = integerSetting(
    env.HOOKSCOPE_MAX_BODY_BYTES,
    "HOOKSCOPE_MAX_BODY_BYTES",
    256 * 1024,
    1024,
    2 * 1024 * 1024,
  );
  const maxCaptures = integerSetting(
    env.HOOKSCOPE_MAX_CAPTURES,
    "HOOKSCOPE_MAX_CAPTURES",
    500,
    1,
    5000,
  );
  const maxDbBytes = integerSetting(
    env.HOOKSCOPE_MAX_DB_BYTES,
    "HOOKSCOPE_MAX_DB_BYTES",
    256 * 1024 * 1024,
    16 * 1024 * 1024,
    1024 * 1024 * 1024,
  );
  let replayTargets = [];
  if (env.HOOKSCOPE_REPLAY_TARGETS) {
    let input;
    try {
      input = JSON.parse(env.HOOKSCOPE_REPLAY_TARGETS);
    } catch {
      throw new ConfigError("HOOKSCOPE_REPLAY_TARGETS must be a JSON array.");
    }
    if (!Array.isArray(input))
      throw new ConfigError("HOOKSCOPE_REPLAY_TARGETS must be a JSON array.");
    if (input.length > 20)
      throw new ConfigError(
        "HOOKSCOPE_REPLAY_TARGETS may contain at most 20 entries.",
      );
    replayTargets = input.map(validateLoopbackTarget);
  }
  const targetIds = new Set();
  for (const target of replayTargets) {
    if (targetIds.has(target.id))
      throw new ConfigError(`Replay target id ${target.id} is duplicated.`);
    targetIds.add(target.id);
  }
  const additionalRedactedHeaders = (env.HOOKSCOPE_REDACT_HEADERS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  for (const name of additionalRedactedHeaders) {
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name))
      throw new ConfigError(
        `Invalid header name in HOOKSCOPE_REDACT_HEADERS: ${JSON.stringify(name)}.`,
      );
  }
  return Object.freeze({
    host: host.trim(),
    port,
    dataDir: path.resolve(cwd, env.HOOKSCOPE_DATA_DIR || "./data"),
    maxBodyBytes,
    maxCaptures,
    maxDbBytes,
    replayTargets: Object.freeze(replayTargets),
    additionalRedactedHeaders: Object.freeze([
      ...new Set(additionalRedactedHeaders),
    ]),
  });
}

export function redactHeaderName(name, additional = []) {
  const lower = name.toLowerCase();
  const builtIn =
    /authorization|cookie|token|secret|password|credential|api[-_]?key|session|signature/i.test(
      lower,
    );
  return builtIn || additional.includes(lower);
}
