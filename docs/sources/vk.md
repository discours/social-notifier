# VK

**English** · [Русский](vk.ru.md)

Community posts are read with the [`wall.get`](https://dev.vk.com/ru/method/wall.get) method, using the service key of an app. The key is not tied to a personal account: changing a password or signing out does not break it.

**What you need:** a VK ID app and its service key. **Cost:** free.

## Key

1. In the [VK ID](https://id.vk.com/) developer console, create an app.
2. In the app settings, copy the **service access key**. It reads the public walls of communities.
3. Save it as a secret:

   ```bash
   gh secret set VK_TOKEN --repo OWNER/REPO
   ```

## Source in the config

```json
{ "id": "vk", "type": "vk", "label": "VK", "ownerId": -89236419 }
```

`ownerId` is the wall ID. For a community it is minus the numeric ID: for `vk.com/club89236419` it is `-89236419`. A short address is converted to an ID with the [`groups.getById`](https://dev.vk.com/ru/method/groups.getById) method.

## What arrives

- Posts made in the name of the community, including reposts on its wall. For a repost without its own text, the message uses the text of the original post.
- Suggested posts and posts by visitors do not arrive (`filter=owner`).
- A pinned old post does not arrive: it was published before watching started.
