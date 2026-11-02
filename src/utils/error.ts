/**
 * Best-effort HTTP status code from a console-sdk watch/create error. The SDK
 * surfaces several shapes: k8s Status objects carry a numeric `code`, axios
 * errors carry `response.status`, and some paths only stringify the message.
 * Returns undefined when nothing parses — callers must treat that as "unknown",
 * never as a specific outcome.
 */
export const httpStatusCode = (e: unknown): number | undefined => {
  if (!e) return undefined;
  const err = e as {
    code?: number | string;
    status?: number | string;
    response?: { status?: number | string };
  };
  const n = Number(err.code ?? err.status ?? err.response?.status);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
