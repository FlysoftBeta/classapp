# ClassApp HTTPS certificate

The local, ignored configuration lives at `worktree/secrets/duckdns.json`:

```json
{
  "domain": "classapp.duckdns.org",
  "duckDnsSubdomain": "classapp",
  "token": "replace-with-your-duckdns-token",
  "renewBeforeDays": 30,
  "preferredChain": "ISRG Root X1"
}
```

Check the existing certificate without changing DNS:

```sh
npm run https:check
```

Issue or renew a production certificate after explicitly accepting the
Let's Encrypt subscriber agreement:

```sh
npm run https:renew
```

Use `-- --staging` on the npm command while testing the workflow. A staging
certificate is deliberately not copied into the deployable certificate
directory. The script uses DuckDNS's TXT API for an ACME DNS-01 challenge,
clears the TXT value after validation, and production renewal writes the
following ignored files:

- `worktree/secrets/https/account-key.pem`
- `worktree/secrets/https/privkey.pem`
- `worktree/secrets/https/fullchain.pem`
- `worktree/secrets/https/root.pem`
- `worktree/secrets/https/config.json`

The release build copies only `https/` into the deployment package. The DuckDNS token
and ACME account key are never included. Set `CLASSAPP_REQUIRE_HTTPS=1` to make
the build fail when the deployable HTTPS files are absent.
