# Chrome 70 production HTTPS E2E

`npm run test:e2e:chrome70` exercises the production boot chain without
binding privileged ports or modifying the system hosts file:

1. Builds a deployment that must contain the real HTTPS credentials.
2. Copies the production launcher/current layout into a temporary directory.
3. Allocates random HTTP and HTTPS ports above 1024.
4. Starts `launcher.js`, enables the HTTP shell redirect, and verifies TLS with
   Node's normal CA trust store.
5. Starts the pinned Chrome 70 binary with `--host-resolver-rules`, mapping
   `www.opensubtitles.org` and `classapp.duckdns.org` to loopback without root.
   SNI and hostname verification still use the real DuckDNS hostname and
   Let's Encrypt certificate.
6. Enters through the legacy HTTP hostname, follows the real cached 301, logs
   in, checks the HTTPS admin panel, and waits for Service Worker control.
7. Stops the complete production launcher and navigates to the legacy HTTP URL
   again. The cached 301, cached shell, and IndexedDB app bundle must start the
   app with no origin server.
8. Restarts the launcher and verifies automatic online recovery.

The test only binds random high TCP ports. It does not use
`--ignore-certificate-errors`, `Security.setOverrideCertificateErrors`, a test
CA, mDNS, or changes to `/etc/hosts`.
