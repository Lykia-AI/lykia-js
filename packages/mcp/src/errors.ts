export const LOGIN_HINT = 'Run `npx @lykia/mcp login` (browser sign-in) or set the LYKIA_API_KEY environment variable.';

/** No usable credentials: the user has to log in (or set an API key). */
export class LoginRequiredError extends Error {
  constructor(reason: string) {
    super(`${reason} ${LOGIN_HINT}`);
    this.name = 'LoginRequiredError';
  }
}

/** The server rejected the credentials we sent. */
export class AuthRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthRejectedError';
  }
}

/** A user-facing error from a CLI command. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}
