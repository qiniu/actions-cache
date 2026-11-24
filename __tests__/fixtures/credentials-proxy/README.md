# Local proxy test certificate

This public test-only key and self-signed certificate are used exclusively by
`credentialsProxy.test.ts` for the reserved hostname `runner.proxy.test`.
The test trusts this certificate on its own agents; TLS verification remains
active. Never use this key or certificate outside test fixtures.
