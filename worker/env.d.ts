// Runtime secrets are configured in the dashboard, so their names must be
// available to TypeScript even in CI without a local .dev.vars file.
interface Env {
  APP_PASSWORD: string;
  SESSION_SECRET: string;
  RESEND_API_KEY: string;
}
