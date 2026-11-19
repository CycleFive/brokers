// Production runs with the global_fetch_strictly_public compatibility flag; Node cannot see it,
// so the OAuth library prints a "CIMD is disabled" notice on import. Present the flag.
(globalThis as any).Cloudflare = { compatibilityFlags: { global_fetch_strictly_public: true } };
