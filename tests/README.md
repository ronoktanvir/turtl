# UI regressions

Start the example UI with `EXPO_PUBLIC_DATA_SOURCE=example npx expo start --web --port 8081`, then run `npm run test:ui`. This explicit override also works when a local Convex setup has written a backend URL to `.env.local`. Do not set a conflicting data-source override in another local environment file.

The citation check uses Chromium at a 390px viewport. Set `CHROME_PATH` when Chrome is not installed at a standard Linux or macOS path; set `UI_BASE_URL` to test another local preview. It compares each linked paragraph against identical plain text and verifies keyboard activation without navigation.

Timing tests check the accelerated example clock independently of a browser.

The live mapping, network, action and query-client tests run without a server. They cover recorded evidence and verification, exact repository identity, owner decisions, scoped permissions, the displayed merge head, and readable failures on a lagging deployment. Their mocked action responses are not proof that an external service ran.

The voice tests load the voice rules, the talk action and the hands-free turn taking without a server. They check that a spoken approve, decline, merge or stop is answered with where its button is and never reaches a decision, the refusals (switch off, missing key, long clip, rate limit), and the work state the case chat answers "what are you stuck on" from.

The GitHub App tests run `convex/github`'s functions against a stand-in for GitHub's API (`scripts/github-app/stub.mjs`) and an in-memory copy of its tables, without a server. They check the app JWT's shape and its signature with the public key, installation token caching and expiry, webhook signatures accepted and refused, replayed deliveries, which repositories an installation covers, and the fallback to `GITHUB_TOKEN` when no GitHub App is configured. They prove nothing about GitHub itself.
