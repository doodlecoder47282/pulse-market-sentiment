# Security status: personal prototype only

**Multi-user brokerage connections and public release are blocked.**
This repository is not assessed as NIST-compliant, certified, or fully secure.
The iPhone gateway is a restricted personal-test interface, not multi-user identity.

## Verified critical gaps

- **Exposed application credentials:** literal Schwab credential assignments were
  removed from the current deployment guide in commit `9f4ea20`, but earlier
  commits retain them. Rotate/revoke them. History cleanup alone is not revocation.
- **Shared brokerage identity:** `server/schwab.ts` reads and writes
  `schwabTokens.id = 1`; `shared/schema.ts` has no user ownership on that table.
  A second connection can replace the first, rather than create an isolated user.
- **Token storage:** the inspected application writes access/refresh token strings
  directly to SQLite. No application-layer encryption is present in that path.
  Host/disk encryption was not assessed and would not replace authorization.
- **Legacy API access:** `server/index.ts` does not apply general user authentication
  to the existing `/api/` surface. The new `/api/mobile/` gate does not secure it.
- **OAuth session binding:** the inspected `getAuthUrl()` does not attach a `state`
  value. Before multi-user use, bind each authorization transaction to an authenticated
  user with one-time, expiring state; validate it before accepting a callback.
- **Response logging:** the existing request logger captures JSON response bodies.
  Replace broad logging with an explicit safe-field policy before real user data.
- **Dependency/type debt:** the current dependency audit reports high findings and
  the repository-wide TypeScript check has unrelated failures. Both require triage
  before distribution; installation/build success is not security clearance.

## Required multi-user design

The intended flow is: sign in to Batcave, choose “Connect Schwab,” authorize on
Schwab's own site, and return to a server callback associated with that same
Batcave user. Do not collect brokerage passwords in the app.

Use an approved application registration and confirm Schwab's current permissions,
OAuth capabilities, distribution approval, and data-redistribution terms with the
provider before enabling this design. Do not assume individual API access permits
a public multi-user product.

1. Managed user identity with phishing-resistant MFA/passkeys; secure recovery,
   session lifetime limits, revocation, and reauthentication for sensitive actions.
2. Server-derived user ID on every private record, query, cache key, background
   job, export, websocket channel, and authorization check. Never trust a client
   `userId` as proof of ownership.
3. Separate per-user brokerage grants; encrypted tokens with a managed encryption
   key outside the database; least-privileged runtime secrets and rotation.
4. Server-side OAuth exchange, exact redirect allowlist, one-time state, replay
   prevention, and PKCE where supported by the selected provider flow. No broker
   app secret in the IPA or JavaScript.
5. Minimal mobile permissions and user sessions. Use Keychain for any deliberately
   persisted app-session secret. Keep brokerage refresh tokens server-side.
6. Default-deny backend authorization, schema validation, bounded requests, safe
   output handling, dependency review, TLS, rate limits, and restricted admin access.
7. Redacted security audit events, suspicious-access detection, incident response,
   credential revocation procedures, encrypted backups, and tested restoration.

“Automatically populate” applies only to the accounts, data scopes, and
entitlements that the user and provider actually authorize. Market-data failures
and disconnected accounts must remain visible; they cannot silently use another
person's brokerage grant.

## NIST-oriented release gate

Use NIST CSF 2.0 to manage risk and document the application's current/target
security profile, not as a badge inferred from a handful of code changes.
[NIST Cybersecurity Framework](https://www.nist.gov/cyberframework)

Use NIST SP 800-218 (SSDF) to define repeatable secure-development requirements,
review, build protection, vulnerability remediation, and supporting evidence.
[NIST SP 800-218](https://csrc.nist.gov/pubs/sp/800/218/final)

Use NIST SP 800-63B-4 as a reference for authentication, phishing resistance,
session management, and recovery requirements. Select and document an appropriate
assurance target; this project has not demonstrated an assurance level.
[NIST Digital Identity Guidelines](https://pages.nist.gov/800-63-4/sp800-63b.html)

Release evidence required:

- Threat model, data-flow inventory, trust boundaries, and control ownership.
- Proof that old credentials are invalid and repository/history scans are reviewed.
- Two-user negative tests: A cannot read, modify, export, reconnect, or disconnect
  B's data, including by changing IDs, replaying callbacks, or hitting legacy routes.
- Tests for revoked/expired sessions, OAuth state reuse/mismatch, missing MFA,
  untrusted origins, untrusted redirects, injection, abusive request volume,
  malicious upstream content, and failed/unavailable data providers.
- Secret scanning, dependency/SAST triage, build artifact review, and an SBOM.
- Independent web/API/mobile penetration test and remediation verification.
- Monitoring, incident response exercise, deletion policy, backup restoration,
  and periodic reassessment.

## If someone obtains the code

The security design must assume the source and mobile binary are observable.
Access control must depend on server-enforced identity, authorization, protected
secrets, and tenant isolation, not hidden URLs or obscure JavaScript.

The current repository history contains an exposure that must be treated as real.
Making the repo private reduces distribution but neither revokes leaked values
nor repairs shared-account architecture. Do not publish secret values in issues.

## Current gate

Keep this build to the owner, behind a restricted network/proxy, without additional
users or new brokerage grants. Do not expose legacy endpoints. The mobile token
is a shared owner credential with rotation-based revocation, not a production
multi-user session system. Public release requires the evidence above.
