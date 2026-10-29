/** OIDC integration boundary. A production adapter must validate issuer,
 * audience, nonce, state, PKCE and signed claims before returning an identity.
 * No route accepts unverified provider claims as an ERP login. */
export interface ExternalIdentity {
  issuer: string;
  subject: string;
  verifiedEmail: string | null;
}
export interface IdentityProvider {
  authorizationUrl(input: {
    state: string;
    nonce: string;
    codeChallenge: string;
    redirectUri: string;
  }): Promise<string>;
  exchangeCode(input: {
    code: string;
    state: string;
    nonce: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<ExternalIdentity>;
}
export function ssoConfiguration(): {
  status: "BLOCKED";
  configured: boolean;
  missing: string[];
} {
  const names = [
    "SSO_ISSUER",
    "SSO_CLIENT_ID",
    "SSO_CLIENT_SECRET",
    "SSO_REDIRECT_URI",
  ];
  const missing = names.filter((name) => !process.env[name]);
  if (!missing.length) {
    for (const name of ["SSO_ISSUER", "SSO_REDIRECT_URI"]) {
      const value = new URL(process.env[name]!);
      if (value.protocol !== "https:" || value.username || value.password)
        throw new Error("SSO URLs require HTTPS without embedded credentials");
    }
  }
  return { status: "BLOCKED", configured: !missing.length, missing };
}
