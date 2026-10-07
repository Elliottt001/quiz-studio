# Cloud Migration Implementation Plan

1. Add failing tests for a public player password, unique login code, cross-device login, logout/revocation, legacy account recovery, and separation from admin sessions. Add fields via an additive SQLite migration. Implement identity routes and responsive login/register switching without changing the quiz rules.
2. Add failing tests for the cloud proxy security contract: exact HTTPS Origin, Secure cookies, inability to bind publicly without a configured trusted proxy or direct TLS, and `DATA_DIR` storage. Implement deployment configuration on a persistent disk and a health check.
3. Document and test that the public build includes the actual three pages and API rather than the Pages-only introduction. Add staging smoke and restart/load instructions, keep the current Pages domain intact until the managed service passes.
4. Run all tests, build, on-host tests if accessible, and code review. Only then change the DNS custom domain to the running cloud service and retire the Pages custom domain. If a cloud account or paid persistent disk cannot be provisioned, report that the live migration is pending instead of redirecting users to a broken app.
