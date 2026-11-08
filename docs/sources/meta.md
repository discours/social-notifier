# Instagram and Facebook

**English** · [Русский](meta.ru.md)

Both networks are read through the Graph API with one **system user** token from a Meta business portfolio. A personal token does not work for this. Meta invalidates personal sessions from time to time (a password change, a security check), and the integration silently stops working. A system user token lives until someone revokes it.

**What you need:** a business portfolio in [Meta Business Suite](https://business.facebook.com/) that owns the Facebook page and the Instagram account. The Instagram account is professional (business or creator) and linked to the page. **Cost:** free.

The menu names below are from the English interface: it changes less often than the translations.

## Token

1. **App.** At [developers.facebook.com/apps](https://developers.facebook.com/apps), create an app of the "Business" type and connect it to your portfolio. You do not need to publish the app or pass App Review: it reads only assets of its own portfolio.
2. **System user.** [Business settings](https://business.facebook.com/settings) → **Users** → **System users** → **Add**, role Employee.
3. **Access.** On the system user → **Assign assets**:
   - the Facebook page — partial Insights access is enough: posts are read with a page token, which the Graph API issues with that access too;
   - the Instagram account — Insights as well;
   - the app from step 1.
4. **Token.** On the system user → **Generate new token** → the app from step 1, expiration **Never**, permissions:
   - `pages_show_list`
   - `pages_read_engagement`
   - `pages_read_user_content`
   - `instagram_basic`

   The token is shown once. Save it right away:

   ```bash
   gh secret set META_TOKEN --repo OWNER/REPO
   ```

5. Run the probe ([setup.md](../setup.md#3-access-probe)). It prints the IDs of all pages the token sees and the Instagram accounts linked to them. The probe reads up to 250 pages; if the token sees more, it says the list is incomplete and ends with code 1.

## Sources in the config

```json
[
  { "id": "instagram", "type": "instagram", "label": "Instagram", "pageId": "1430627470564984" },
  { "id": "facebook", "type": "facebook", "label": "Facebook", "pageId": "1430627470564984" }
]
```

For both sources, `pageId` is the numeric ID of the Facebook page. Instagram is found through it: the radar takes the account linked to the page.

The default Graph API version is `v25.0`. To use another one, set the `graphApiVersion` field at the root of the config.

## What arrives

- Instagram: posts, carousels, and Reels of the account itself. Stories, and collaborative posts where the account is a collaborator but not the owner, do not appear in the `/media` response.
- Facebook: posts made in the name of the page, without visitor posts.
