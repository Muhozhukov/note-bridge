# OAuth branding pages

Static homepage, Privacy Policy and Terms of Use for the existing personal Note Bridge service. No JavaScript, analytics, Firebase Authentication, functions, database or billing setup is needed. The existing Cloudflare Worker is not migrated.

Deployment is NOT completed by committing these files. Firebase access and the target Google Cloud project must first be confirmed. Use Firebase Hosting (not App Hosting), keep the no-cost Spark plan; do not enable Blaze or billing automatically. No project ID or deployment URL is invented in this directory.

After connection: select the intended existing project, inspect its Hosting sites to avoid overwriting another website, create/select a dedicated site if necessary, publish this directory using its firebase.json, then verify all three URLs. If a local CLI is used, the command from this directory is `firebase deploy --only hosting --project ACTUAL_PROJECT_ID`; do not run until the real project and site target are verified.

Branding URLs after successful deployment: homepage `/`, privacy `/privacy/`, terms `/terms/`. Only fill Google Auth Platform with the actual verified HTTPS host. Add the appropriate authorized domain and complete any Search Console ownership check Google requires. This hostname must not be confused with ownership of all of web.app or firebaseapp.com.

The OAuth callback remains the currently configured Worker `/callback`. A branding review can also require verification of callback domains; a new website alone does not resolve that requirement. Do not change PUBLIC_ORIGIN, redirect URIs, secrets or existing credentials as a side effect of publishing pages.

Publishing status, branding verification and restricted-scope verification are separate. The app requests `openid`, `email`, and `https://www.googleapis.com/auth/drive`. Personal/family use may qualify for a verification exception; that is not a promise that Console publication will be unblocked. Public distribution may require restricted-scope review and a security assessment depending on architecture and Google requirements.

The privacy text is based on the current repository implementation. The owner must confirm actual deployment practices and keep the support contact current. GitHub issues are public: never post private user data there. A public release should use a dedicated private support/deletion contact. After production publication, reconnect expired Google grants and verify token refresh and folder access. Keep explicit allowed email restrictions for personal use.
