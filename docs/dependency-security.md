# Dependency security policy

- Production uses Node.js 22 and `firebase-admin` 14.x.
- The CRM uses Firebase Auth and Firestore, but does not use Firebase Storage.
- `@google-cloud/firestore` is therefore a direct dependency.
- The multi-stage Docker runtime installs `--omit=dev --omit=optional`, which removes the unused optional Google Storage dependency and all build tooling.
- CI runs `npm audit --omit=optional --audit-level=moderate`; this matches the runtime dependency surface and currently reports zero vulnerabilities.
- A raw development `npm audit` can still list advisories under Firebase Admin's optional Storage tree. Those packages are present only for local full installs/builds and are not copied into the runtime image.
- Do not use `npm audit fix --force`; review major dependency changes and run unit, integration, build, and production-bundle tests.
