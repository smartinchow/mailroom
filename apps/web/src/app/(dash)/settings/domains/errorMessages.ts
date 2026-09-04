/** Human-readable text for the admin API's domain error codes (surfaced via ?error=). */
export const DOMAIN_ERROR_MESSAGES: Record<string, string> = {
  invalid_domain: "That doesn't look like a valid domain name.",
  domain_exists: "That domain is already registered.",
  no_default_carrier:
    "No default carrier is configured — set one in Settings → Carriers first.",
  provider_error: "The carrier rejected the request. Check its credentials and try again.",
  domain_in_use: "This domain has messages and cannot be deleted.",
  unknown: "Something went wrong. Please try again.",
};

export function domainErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return DOMAIN_ERROR_MESSAGES[code] ?? DOMAIN_ERROR_MESSAGES.unknown;
}
