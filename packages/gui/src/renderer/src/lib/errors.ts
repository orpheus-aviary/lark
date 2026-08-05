// One place to turn a thrown value into something a toast can show. ApiError
// already carries the daemon's Chinese message, so it needs no special case.

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
