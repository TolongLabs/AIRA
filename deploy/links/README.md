# Footer Short Links

This Worker stores source URLs from authenticated AIRA requests for 365 days and redirects readers
from short codes to the source pages.

Set the `LINKS` KV namespace ID in `wrangler.toml`. Set `CLOUDFLARE_ACCOUNT_ID` in your shell and configure
the custom hostname for this Worker. From this directory, run `wrangler deploy` and then
`wrangler secret put LINKS_SECRET`. Use the same secret in AIRA and set `links.baseUrl` to the Worker origin.

See the [Wrangler configuration documentation](https://developers.cloudflare.com/workers/wrangler/configuration/)
for account and KV binding settings and the
[Workers secrets documentation](https://developers.cloudflare.com/workers/configuration/secrets/) for secret storage.
