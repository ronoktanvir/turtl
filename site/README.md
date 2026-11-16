# turtl's public pages

The privacy policy, terms of use, and support page that the App Store listing and the app link to. GitHub Pages builds them with Jekyll and serves them at:

- https://ronoktanvir.github.io/turtl/privacy/
- https://ronoktanvir.github.io/turtl/terms/
- https://ronoktanvir.github.io/turtl/support/

## Filling in the blanks

Every blank is a value in `_data/operator.json`. A page shows an empty one as a dashed amber box naming what is missing.

| Key | What goes in it |
| --- | --- |
| `legal_name` | The person or company that runs turtl, as it should appear in the policy and the App Store copyright line |
| `contact_email` | The address people write to for support, privacy requests, and security reports |
| `postal_address` | Optional. Shown under the name when set. Apple asks for one where local law requires it |
| `governing_law` | The state or country whose law governs the terms, for example "the State of California, USA" |
| `effective_date` | The day the policy and terms take effect, written out, for example "1 December 2026" |
| `backup_retention_days` | How many days a deleted account can survive in the backend's backups |
| `support_reply_days` | How many working days a support email may wait for a reply |
| `show_review_notes` | `true` shows an amber "To confirm before launch" note beside each sentence that depends on unfinished work. Set it to `false` once every note is settled |

`node store/check.mjs` lists every blank and every note that is still open, and `node store/check.mjs --release` fails while any remain.

## Publishing

`.github/workflows/pages.yml` builds the pages on every pull request that touches `site/` and publishes them on every push to `main`. Publishing needs one repository setting, made once: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Looking at the pages before they are published

This builds them with the same image GitHub uses, in a folder outside the repository:

```sh
rm -rf /tmp/turtl-site && mkdir -p /tmp/turtl-site && cp -r site /tmp/turtl-site/site
docker run --rm -v /tmp/turtl-site:/github/workspace -e GITHUB_WORKSPACE=/github/workspace \
  -e INPUT_SOURCE=site -e INPUT_DESTINATION=_site -e INPUT_FUTURE=false -e INPUT_VERBOSE=false \
  -e GITHUB_REPOSITORY=ronoktanvir/turtl -e PAGES_REPO_NWO=ronoktanvir/turtl -e JEKYLL_ENV=production \
  ghcr.io/actions/jekyll-build-pages:v1.0.13
python3 -m http.server 4173 --directory /tmp/turtl-site/_site
```

Then open http://localhost:4173/privacy/.

Links between the pages are relative, so the built folder works from any address.
